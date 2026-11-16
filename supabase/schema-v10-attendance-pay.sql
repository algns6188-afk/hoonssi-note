-- 강철노트 v10: 출석부(일별·월별) 지난 날짜 수정 · 학부모 카드/토스페이 결제
-- schema-v9-billing-table.sql 다음에 실행. 여러 번 실행해도 안전합니다.

-- 지난 날짜 출석을 고칠 때는 학부모에게 등·하원 알림을 보내지 않음 (30분 넘게 지난 기록)
create or replace function public.notify_attendance() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_secret text;
begin
  if new.at < now() - interval '30 minutes' then return new; end if;
  select value into v_url from private.config where key = 'notify_url';
  select value into v_secret from private.config where key = 'notify_secret';
  if v_url is null then return new; end if;
  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('attendance_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret),
    timeout_milliseconds := 10000
  );
  return new;
end $$;

-- 온라인 결제 (토스페이먼츠). 클라이언트 키는 공개돼도 되는 값, 시크릿 키는 Edge Function 비밀값에만
alter table public.orgs add column if not exists toss_client_key text not null default '';
alter table public.invoices add column if not exists payment_key text;

drop function if exists public.org_bank();
create function public.org_bank()
returns table (name text, bank_name text, bank_account text, account_holder text,
               bank2_name text, bank2_account text, account2_holder text, toss_client_key text)
language sql stable security definer set search_path = public as $$
  select name, bank_name, bank_account, account_holder, bank2_name, bank2_account, account2_holder, toss_client_key
    from public.orgs where id = public.my_org()
$$;
grant execute on function public.org_bank() to authenticated;
notify pgrst, 'reload schema';
