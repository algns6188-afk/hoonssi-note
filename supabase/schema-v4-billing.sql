-- 강철노트 v4: 수납 관리 (청구 · 학부모 입금 신고 · 관리자 확인 · 매달 1일 자동 청구)
-- schema-v3-push.sql 다음에 실행. 여러 번 실행해도 안전합니다.

/* ---------------- 도장 계좌 ---------------- */

alter table public.orgs add column if not exists bank_name text not null default '';
alter table public.orgs add column if not exists bank_account text not null default '';
alter table public.orgs add column if not exists account_holder text not null default '';

/* ---------------- 청구 항목 (수련비 · 심사비 …) ---------------- */

create table if not exists public.fee_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  name text not null,
  default_amount int not null default 0 check (default_amount >= 0),
  monthly boolean not null default false,     -- 매달 1일 자동 청구 항목 (수련비)
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

insert into public.fee_items (org_id, name, default_amount, monthly, sort)
select o.id, v.name, 0, v.monthly, v.sort
from public.orgs o,
  (values ('수련비', true, 1), ('심사비', false, 2), ('대회 참가비', false, 3), ('도복비', false, 4), ('체험학습비', false, 5)) as v(name, monthly, sort)
on conflict (org_id, name) do nothing;

/* ---------------- 학생별 수련비 · 자동 청구 여부 · 예금주명 ---------------- */

alter table public.students add column if not exists monthly_fee int check (monthly_fee is null or monthly_fee >= 0);
alter table public.students add column if not exists auto_bill boolean not null default true;

-- 입금할 때 찍히는 이름 (엄마·아빠·할머니 등 여러 개)
create table if not exists public.payer_names (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (student_id, name)
);

/* ---------------- 청구서 ---------------- */

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  student_id uuid not null references public.students on delete cascade,
  item_name text not null,
  period text,                                   -- 수련비: '2026-11' / 그 외: null
  amount int not null check (amount >= 0),
  due_date date,
  status text not null default 'unpaid' check (status in ('unpaid', 'reported', 'paid', 'canceled')),
  memo text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  reported_at timestamptz,
  reported_by uuid,
  reported_payer text,
  paid_at timestamptz,
  paid_amount int,
  paid_method text check (paid_method is null or paid_method in ('transfer', 'cash', 'card', 'other')),
  confirmed_by uuid
);
create index if not exists invoices_org_status_idx on public.invoices (org_id, status, created_at desc);
create index if not exists invoices_student_idx on public.invoices (student_id, created_at desc);
-- 같은 달 수련비가 두 번 청구되지 않게
create unique index if not exists invoices_once_per_period on public.invoices (student_id, item_name, period)
  where period is not null and status <> 'canceled';

/* ---------------- 권한 ---------------- */

alter table public.fee_items enable row level security;
alter table public.payer_names enable row level security;
alter table public.invoices enable row level security;
grant select, insert, update, delete on public.fee_items, public.payer_names, public.invoices to authenticated;
grant select, insert, update, delete on public.fee_items, public.payer_names, public.invoices to service_role;

drop policy if exists fee_staff on public.fee_items;
create policy fee_staff on public.fee_items for all to authenticated
  using (org_id = public.my_org() and public.is_staff()) with check (org_id = public.my_org() and public.is_staff());

drop policy if exists payer_staff on public.payer_names;
create policy payer_staff on public.payer_names for all to authenticated
  using (public.is_staff() and exists (select 1 from public.students s where s.id = student_id and s.org_id = public.my_org()))
  with check (public.is_staff() and exists (select 1 from public.students s where s.id = student_id and s.org_id = public.my_org()));
drop policy if exists payer_parent on public.payer_names;
create policy payer_parent on public.payer_names for select to authenticated using (public.is_my_child(student_id));

drop policy if exists invoice_staff on public.invoices;
create policy invoice_staff on public.invoices for all to authenticated
  using (org_id = public.my_org() and public.is_staff()) with check (org_id = public.my_org() and public.is_staff());
drop policy if exists invoice_parent on public.invoices;
create policy invoice_parent on public.invoices for select to authenticated
  using (org_id = public.my_org() and public.is_my_child(student_id));

-- 학부모가 도장 계좌를 볼 수 있게 (계좌 정보만)
create or replace function public.org_bank()
returns table (name text, bank_name text, bank_account text, account_holder text)
language sql stable security definer set search_path = public as $$
  select name, bank_name, bank_account, account_holder from public.orgs where id = public.my_org()
$$;

/* ---------------- 학부모: "입금했어요" ---------------- */

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
  -- 처음 보는 입금자명이면 학생의 예금주명 목록에 추가 (다음 자동 확인용)
  if nullif(trim(p_payer), '') is not null then
    insert into public.payer_names (student_id, name) values (inv.student_id, trim(p_payer)) on conflict do nothing;
  end if;
end $$;

/* ---------------- 수련비 일괄 청구 ---------------- */

-- 내부용 (매달 1일 자동 실행이 사용): 대상 학생에게 그 달 수련비 청구서를 만듦
create or replace function public.bill_month_internal(p_org uuid, p_period text, p_students uuid[], p_due date, p_actor uuid)
returns int
language plpgsql security definer set search_path = public as $$
declare v_default int; v_count int;
begin
  if p_period !~ '^\d{4}-\d{2}$' then raise exception 'bad period'; end if;
  select default_amount into v_default from public.fee_items where org_id = p_org and name = '수련비';
  insert into public.invoices (org_id, student_id, item_name, period, amount, due_date, created_by)
  select s.org_id, s.id, '수련비', p_period, coalesce(s.monthly_fee, v_default, 0),
         coalesce(p_due, greatest((p_period || '-10')::date, (now() at time zone 'Asia/Seoul')::date + 7)), p_actor
  from public.students s
  where s.org_id = p_org and s.active
    and (case when p_students is null then s.auto_bill else s.id = any (p_students) end)
    and coalesce(s.monthly_fee, v_default, 0) > 0
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke execute on function public.bill_month_internal(uuid, text, uuid[], date, uuid) from public, anon, authenticated;

-- 관리자 버튼: p_students 가 비어 있으면 '자동 청구' 체크된 학생 모두
create or replace function public.bill_month(p_period text, p_students uuid[] default null, p_due date default null)
returns int
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  return public.bill_month_internal(public.my_org(), p_period, p_students, p_due, auth.uid());
end $$;

-- 매달 1일 자동: 모든 도장
create or replace function public.bill_month_all()
returns int
language plpgsql security definer set search_path = public as $$
declare o record; total int := 0; p text := to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM');
begin
  for o in select id from public.orgs loop
    total := total + public.bill_month_internal(o.id, p, null, null, null);
  end loop;
  return total;
end $$;
revoke execute on function public.bill_month_all() from public, anon, authenticated;

grant execute on function public.org_bank(), public.report_payment(uuid, text), public.bill_month(text, uuid[], date) to authenticated;

/* ---------------- 타임라인 자동 기록 + 학부모 알림 ---------------- */

create or replace function public.won(n int) returns text language sql immutable as $$
  select to_char(n, 'FM999,999,999') || '원'
$$;

create or replace function public.invoice_label(i public.invoices) returns text language sql stable as $$
  select case when i.period is not null then to_number(split_part(i.period, '-', 2), '99')::text || '월 ' else '' end || i.item_name
$$;

create or replace function public.invoices_after() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare sname text; who text; v_url text; v_secret text; ev text;
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
    insert into public.timeline (org_id, kind, summary, student_id, ref_table, ref_id, actor)
    values (new.org_id, 'payment',
      sname || ' ' || public.invoice_label(new) || ' ' ||
      case new.status
        when 'reported' then '입금 완료 알림 (학부모' || coalesce(' · 입금자 ' || new.reported_payer, '') || ')'
        when 'paid' then '납부 완료 ' || public.won(coalesce(new.paid_amount, new.amount)) ||
          case new.paid_method when 'cash' then ' · 현금' when 'card' then ' · 카드' when 'transfer' then ' · 계좌이체' else '' end ||
          coalesce(' (확인: ' || nullif(who, '') || ')', '')
        when 'canceled' then '청구 취소'
        when 'unpaid' then '미납으로 되돌림'
      end,
      new.student_id, 'invoices', new.id, auth.uid());
    ev := case new.status when 'paid' then 'paid' else null end;
  end if;

  -- 청구됐을 때, 납부 확인됐을 때 학부모 폰으로 알림
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

/* ---------------- 실시간 반영 ---------------- */

do $$
begin
  begin
    execute 'alter publication supabase_realtime add table public.invoices';
  exception when duplicate_object then null;
  end;
end $$;

/* ---------------- 매달 1일 오전 9시 5분(한국 시간) 수련비 자동 청구 ---------------- */

create extension if not exists pg_cron;
select cron.schedule('kangcheol-monthly-tuition', '5 0 1 * *', 'select public.bill_month_all()');
