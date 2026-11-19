-- 강철노트 v21: 현금영수증 실제 발급 기록 (승인번호·종류·발급일·영수증 주소) + 미발급 알림용
-- schema-v20-dismissal-start.sql 다음에 실행. 여러 번 실행해도 안전합니다.

alter table public.invoices add column if not exists receipt_type text not null default '';        -- 소득공제 / 지출증빙
alter table public.invoices add column if not exists receipt_approval text not null default '';    -- 국세청 승인번호
alter table public.invoices add column if not exists receipt_at timestamptz;                       -- 발급 시각
alter table public.invoices add column if not exists receipt_key text;                             -- 토스페이먼츠 영수증 키 (취소용)
alter table public.invoices add column if not exists receipt_url text;                             -- 영수증 보기 주소
alter table public.invoices add column if not exists receipt_how text not null default '';         -- 자동(강철노트) / 단말기 / 홈택스

-- 현금영수증 발급·취소는 타임라인에 남김
create or replace function public.invoice_receipt_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare sname text;
begin
  if new.receipt_issued is distinct from old.receipt_issued then
    select name into sname from public.students where id = new.student_id;
    insert into public.timeline (org_id, kind, summary, student_id, ref_table, ref_id, actor)
    values (new.org_id, 'payment',
      '🧾 ' || sname || ' ' || public.invoice_label(new) || ' 현금영수증 ' ||
      case when new.receipt_issued then '발급 ' || public.won(coalesce(new.paid_amount, new.amount)) ||
             coalesce(' · 승인번호 ' || nullif(new.receipt_approval, ''), '') ||
             coalesce(' · ' || nullif(new.receipt_how, ''), '')
           else '취소' end,
      new.student_id, 'invoices', new.id, auth.uid());
  end if;
  return new;
end $$;
drop trigger if exists invoice_receipt_log on public.invoices;
create trigger invoice_receipt_log after update of receipt_issued on public.invoices
  for each row execute function public.invoice_receipt_log();
notify pgrst, 'reload schema';
