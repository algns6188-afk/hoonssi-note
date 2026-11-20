-- 강철노트 v27: 결제 이력·알림 보강
-- schema-v26-easypay.sql 다음에 실행. 여러 번 실행해도 안전합니다.
-- · 타임라인: 온라인(이지페이) 결제는 "카드(이지페이) · 온라인 결제"로, 카드 결제 취소는 "카드 결제 취소(환불)"로 기록
-- · 알림: 학부모 온라인 결제 / "입금했어요" 신고 / 카드 결제 취소 → 도장 폰(관리자·선생님)에도 알림
--         카드 결제 취소 → 학부모 폰에도 알림   (notify 서버 함수도 새 코드로 다시 배포해야 함)

create or replace function public.invoices_after() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare sname text; who text; v_url text; v_secret text; ev text; refund boolean;
begin
  select name into sname from public.students where id = new.student_id;
  select display_name into who from public.members where user_id = auth.uid();
  if tg_op = 'INSERT' then
    insert into public.timeline (org_id, kind, summary, student_id, ref_table, ref_id, actor)
    values (new.org_id, 'payment', sname || ' ' || public.invoice_label(new) || ' ' || public.won(new.amount) || ' 청구'
      || case when new.created_by is null then ' (매달 1일 자동)' else '' end,
      new.student_id, 'invoices', new.id, new.created_by);
    ev := 'created';
  elsif new.status is distinct from old.status then
    refund := old.status = 'paid' and new.status = 'unpaid' and coalesce(old.paid_via, '') like '%이지페이%' and coalesce(new.memo, '') like '%카드 결제 취소%';
    insert into public.timeline (org_id, kind, summary, student_id, ref_table, ref_id, actor)
    values (new.org_id, 'payment',
      sname || ' ' || public.invoice_label(new) || ' ' ||
      case
        when new.status = 'reported' then '입금 완료 알림 (학부모' || coalesce(' · 입금자 ' || new.reported_payer, '') || ')'
        when new.status = 'paid' and coalesce(new.paid_via, '') like '%이지페이%' then
          '납부 완료 ' || public.won(coalesce(new.paid_amount, new.amount)) || ' · ' || new.paid_via || ' (학부모 온라인 결제)'
        when new.status = 'paid' then '납부 완료 ' || public.won(coalesce(new.paid_amount, new.amount)) ||
          case new.paid_method when 'cash' then ' · 현금' when 'card' then ' · 카드' when 'transfer' then ' · 계좌이체' else '' end ||
          coalesce(' (확인: ' || nullif(who, '') || ')', '')
        when new.status = 'canceled' then '청구 취소'
        when refund then '카드 결제 취소 (환불 ' || public.won(coalesce(old.paid_amount, old.amount)) || ')' || coalesce(' · ' || nullif(who, ''), '')
        when new.status = 'unpaid' then '미납으로 되돌림'
      end,
      new.student_id, 'invoices', new.id, auth.uid());
    ev := case when new.status = 'paid' then 'paid' when new.status = 'reported' then 'reported' when refund then 'refund' else null end;
  end if;

  -- 알림 서버 호출 (청구·납부 → 학부모 / 온라인 결제·입금 신고·결제 취소 → 도장)
  if ev is not null then
    select value into v_url from private.config where key = 'notify_url';
    select value into v_secret from private.config where key = 'notify_secret';
    if v_url is not null then
      perform net.http_post(url := v_url,
        body := jsonb_build_object('invoice_id', new.id, 'event', ev),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret),
        timeout_milliseconds := 10000);
    end if;
  end if;
  return new;
end $$;

drop trigger if exists invoices_after on public.invoices;
create trigger invoices_after after insert or update on public.invoices
  for each row execute function public.invoices_after();
notify pgrst, 'reload schema';
