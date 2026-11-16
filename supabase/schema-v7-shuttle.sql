-- 강철노트 v7: 강철셔틀 차량표 (차량 · 정류장 · 운행 · 정류장 순서 · 학생 배정)
-- schema-v6-students.sql 다음에 실행. 여러 번 실행해도 안전합니다.
-- 모든 표에 org_id(도장)가 있어 가맹점별로 분리됩니다.

create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  name text not null,                         -- 1호차
  plate text not null default '',
  capacity int not null default 15 check (capacity between 1 and 45),
  driver_user uuid references auth.users on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

-- 동네별 고정 정류장
create table if not exists public.stops (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  name text not null,
  address text not null default '',
  wait_note text not null default '',         -- 대기 위치 설명
  lat double precision,
  lng double precision,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

-- 운행: 1부 등원, 1부 하원(+2부 등원) …
create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  vehicle_id uuid references public.vehicles on delete set null,
  name text not null,
  session_no int,                             -- 몇 부 수업과 관련된 운행인지
  kind text not null check (kind in ('to', 'from', 'mixed')),   -- 등원 / 하원 / 하원+등원
  class_start time,                           -- 수업 시작 (지각 검사용)
  weekdays text not null default '월,화,수,목,금',
  cutoff_minutes int not null default 60 check (cutoff_minutes between 0 and 1440),  -- 출발 몇 분 전 신청 마감
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

-- 운행의 정류장 (요일마다 시간이 다를 수 있어 시간·요일을 함께 저장, 순서는 시간순)
create table if not exists public.run_stops (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs on delete cascade,
  stop_id uuid not null references public.stops on delete restrict,
  at_time time not null,
  weekdays text,                              -- null 이면 운행 요일 전체
  note text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists run_stops_run_idx on public.run_stops (run_id, at_time);

-- 학생 배정: 이 정류장에서 타는지(board)/내리는지(alight), 어느 요일인지
create table if not exists public.ride_assignments (
  id uuid primary key default gen_random_uuid(),
  run_stop_id uuid not null references public.run_stops on delete cascade,
  student_id uuid not null references public.students on delete cascade,
  action text not null check (action in ('board', 'alight')),
  weekdays text,                              -- null 이면 정류장 요일 전체
  note text not null default '',
  created_at timestamptz not null default now(),
  unique (run_stop_id, student_id, action)
);
create index if not exists ride_assignments_student_idx on public.ride_assignments (student_id);

/* ---------------- 권한: 선생님·관리자는 전부, 학부모는 우리 아이 관련만 보기 ---------------- */

alter table public.vehicles enable row level security;
alter table public.stops enable row level security;
alter table public.runs enable row level security;
alter table public.run_stops enable row level security;
alter table public.ride_assignments enable row level security;
grant select, insert, update, delete on public.vehicles, public.stops, public.runs, public.run_stops, public.ride_assignments to authenticated, service_role;

drop policy if exists vehicle_staff on public.vehicles;
create policy vehicle_staff on public.vehicles for all to authenticated
  using (org_id = public.my_org() and public.is_staff()) with check (org_id = public.my_org() and public.is_staff());
drop policy if exists stop_staff on public.stops;
create policy stop_staff on public.stops for all to authenticated
  using (org_id = public.my_org() and public.is_staff()) with check (org_id = public.my_org() and public.is_staff());
-- 학부모는 정류장 목록을 보고 변경 신청할 때 고를 수 있음
drop policy if exists stop_parent on public.stops;
create policy stop_parent on public.stops for select to authenticated using (org_id = public.my_org() and active);
drop policy if exists run_staff on public.runs;
create policy run_staff on public.runs for all to authenticated
  using (org_id = public.my_org() and public.is_staff()) with check (org_id = public.my_org() and public.is_staff());
drop policy if exists run_parent on public.runs;
create policy run_parent on public.runs for select to authenticated using (org_id = public.my_org() and active);
drop policy if exists run_stop_staff on public.run_stops;
create policy run_stop_staff on public.run_stops for all to authenticated
  using (public.is_staff() and exists (select 1 from public.runs r where r.id = run_id and r.org_id = public.my_org()))
  with check (public.is_staff() and exists (select 1 from public.runs r where r.id = run_id and r.org_id = public.my_org()));
drop policy if exists run_stop_parent on public.run_stops;
create policy run_stop_parent on public.run_stops for select to authenticated
  using (exists (select 1 from public.runs r where r.id = run_id and r.org_id = public.my_org()));
drop policy if exists ride_staff on public.ride_assignments;
create policy ride_staff on public.ride_assignments for all to authenticated
  using (public.is_staff() and exists (select 1 from public.students s where s.id = student_id and s.org_id = public.my_org()))
  with check (public.is_staff() and exists (select 1 from public.students s where s.id = student_id and s.org_id = public.my_org()));
drop policy if exists ride_parent on public.ride_assignments;
create policy ride_parent on public.ride_assignments for select to authenticated using (public.is_my_child(student_id));

do $$
declare t text;
begin
  foreach t in array array['runs', 'run_stops', 'ride_assignments', 'stops', 'vehicles'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
