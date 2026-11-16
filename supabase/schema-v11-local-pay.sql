-- 강철노트 v11: 지역화폐(경기지역화폐 등) 도장 방문 결제
-- schema-v10-attendance-pay.sql 다음에 실행. 여러 번 실행해도 안전합니다.
-- local_pay 에 이름(예: '경기지역화폐')을 넣으면 학부모 결제 화면에 "지역화폐 (도장에서 결제)" 가 보입니다. 비우면 숨김.

alter table public.orgs add column if not exists local_pay text not null default '';

drop function if exists public.org_bank();
create function public.org_bank()
returns table (name text, bank_name text, bank_account text, account_holder text,
               bank2_name text, bank2_account text, account2_holder text, toss_client_key text, local_pay text)
language sql stable security definer set search_path = public as $$
  select name, bank_name, bank_account, account_holder, bank2_name, bank2_account, account2_holder, toss_client_key, local_pay
    from public.orgs where id = public.my_org()
$$;
grant execute on function public.org_bank() to authenticated;

-- 학부모 "입금했어요"/"지역화폐로 낼게요": 지역화폐(방문결제)는 예금주명 목록에 넣지 않음
create or replace function public.report_payment(p_invoice uuid, p_payer text)
returns void
language plpgsql security definer set search_path = public as $$
declare inv record;
begin
  select * into inv from public.invoices where id = p_invoice;
  if inv.id is null or not public.is_my_child(inv.student_id) then raise exception 'not allowed'; end if;
  if inv.status <> 'unpaid' then return; end if;
  update public.invoices set status = 'reported', reported_at = now(), reported_by = auth.uid(),
    reported_payer = nullif(trim(p_payer), '') where id = p_invoice;
  if nullif(trim(p_payer), '') is not null and trim(p_payer) not like '%(방문결제)' then
    insert into public.payer_names (student_id, name) values (inv.student_id, trim(p_payer)) on conflict do nothing;
  end if;
end $$;
notify pgrst, 'reload schema';
