-- 강철노트 v26: 이지페이(KICC) 온라인 결제 — 카드 결제 + 가상계좌(학부모 전용 입금계좌)
-- schema-v25-bad-location.sql 다음에 실행. 여러 번 실행해도 안전합니다.
-- 상점ID(MID)는 비밀이 아니라서 orgs 에 저장. 비밀키는 저장하지 않음 (필요하면 Supabase 비밀값 EASYPAY_SECRET_KEY)

alter table public.orgs add column if not exists easypay_mid text;            -- 예: T0022738 (테스트), 계약 후 실제 MID
alter table public.orgs add column if not exists easypay_live boolean not null default false;   -- false = 테스트 서버
alter table public.orgs add column if not exists easypay_vbank boolean not null default false;  -- 가상계좌 보이기

/* 결제 한 건(주문) = 청구서 여러 장 */
create table if not exists public.easypay_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  order_no text not null unique,                 -- 이지페이 shopOrderNo
  invoice_ids uuid[] not null,
  amount integer not null,
  method text not null check (method in ('card', 'vbank')),
  status text not null default 'ready' check (status in ('ready', 'paid', 'waiting', 'failed', 'canceled', 'check')),
  pg_cno text,                                   -- 이지페이 거래번호
  vbank jsonb,                                   -- 가상계좌 정보 (은행·계좌번호·입금기한)
  message text,
  back_url text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  raw jsonb                                      -- 이지페이 응답 (문제 확인용)
);
create index if not exists easypay_orders_org_idx on public.easypay_orders (org_id, created_at desc);
alter table public.easypay_orders enable row level security;
grant select on public.easypay_orders to authenticated;
grant all on public.easypay_orders to service_role;
drop policy if exists ep_order_read on public.easypay_orders;
create policy ep_order_read on public.easypay_orders for select to authenticated
  using ((org_id = public.my_org() and public.is_staff()) or created_by = auth.uid());

/* 이지페이 노티(입금 알림 등) 기록 */
create table if not exists public.easypay_notis (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  order_no text,
  body jsonb,
  handled text
);
alter table public.easypay_notis enable row level security;
grant all on public.easypay_notis to service_role;
grant select on public.easypay_notis to authenticated;
drop policy if exists ep_noti_read on public.easypay_notis;
create policy ep_noti_read on public.easypay_notis for select to authenticated
  using (public.is_staff() and exists (select 1 from public.easypay_orders o where o.order_no = easypay_notis.order_no and o.org_id = public.my_org()));

/* 학부모·직원 화면: 이지페이 켜져 있는지 */
create or replace function public.org_easypay() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('on', coalesce(easypay_mid, '') <> '', 'vbank', easypay_vbank, 'live', easypay_live)
    from public.orgs where id = public.my_org()
$$;
grant execute on function public.org_easypay() to authenticated;
notify pgrst, 'reload schema';
