-- 강철노트 v9: 수납 표 보기 (결제방법 목록 · 현금영수증 · 납부 알림 다시 보내기)
-- schema-v8-phone-login.sql 다음에 실행. 여러 번 실행해도 안전합니다.

alter table public.invoices add column if not exists paid_via text not null default '';      -- 결제방법 이름 (국민은행_건요, 카드 …)
alter table public.invoices add column if not exists receipt_no text not null default '';    -- 현금영수증 번호
alter table public.invoices add column if not exists receipt_issued boolean not null default false;

-- 도장별 결제방법 목록 (계좌가 여러 개면 계좌마다 하나씩)
create table if not exists public.pay_methods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  name text not null,
  kind text not null default 'transfer' check (kind in ('transfer', 'cash', 'card', 'other')),
  sort int not null default 0,
  active boolean not null default true,
  unique (org_id, name)
);
insert into public.pay_methods (org_id, name, kind, sort)
select o.id, v.name, v.kind, v.sort from public.orgs o,
  (values ('계좌이체', 'transfer', 1), ('카드', 'card', 2), ('현금', 'cash', 3), ('바우처+카드', 'card', 4)) v(name, kind, sort)
on conflict (org_id, name) do nothing;

alter table public.pay_methods enable row level security;
grant select, insert, update, delete on public.pay_methods to authenticated, service_role;
drop policy if exists pay_method_staff on public.pay_methods;
create policy pay_method_staff on public.pay_methods for all to authenticated
  using (org_id = public.my_org() and public.is_staff()) with check (org_id = public.my_org() and public.is_staff());

-- 선택한 미납 청구서의 학부모에게 납부 알림 다시 보내기
create or replace function public.remind_invoices(p_ids uuid[])
returns int
language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_secret text; inv record; n int := 0;
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  select value into v_url from private.config where key = 'notify_url';
  select value into v_secret from private.config where key = 'notify_secret';
  for inv in select id from public.invoices
             where id = any (p_ids) and org_id = public.my_org() and status in ('unpaid', 'reported') loop
    if v_url is not null then
      perform net.http_post(url := v_url,
        body := jsonb_build_object('invoice_id', inv.id, 'event', 'created'),
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret),
        timeout_milliseconds := 10000);
    end if;
    n := n + 1;
  end loop;
  if n > 0 then
    insert into public.timeline (org_id, kind, summary, actor)
    values (public.my_org(), 'payment', '납부 알림 ' || n || '건 발송 (미납 학부모)', auth.uid());
  end if;
  return n;
end $$;
grant execute on function public.remind_invoices(uuid[]) to authenticated;
