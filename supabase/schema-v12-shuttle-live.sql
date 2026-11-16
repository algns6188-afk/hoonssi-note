-- 강철노트 v12: 강철셔틀 실시간 위치 (기사님 폰 GPS → 관리자·학부모 노선도/지도)
-- schema-v11-local-pay.sql 다음에 실행. 여러 번 실행해도 안전합니다.

-- 도장 위치 (지도에서 출발·도착 지점)
alter table public.orgs add column if not exists lat double precision;
alter table public.orgs add column if not exists lng double precision;

-- 오늘의 운행 (운행 하나 × 날짜 하나)
create table if not exists public.shuttle_trips (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  run_id uuid not null references public.runs on delete cascade,
  day date not null default (now() at time zone 'Asia/Seoul')::date,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  driver uuid default auth.uid(),
  lat double precision,
  lng double precision,
  speed real,                 -- km/h
  pos_at timestamptz,
  passed jsonb not null default '{}'::jsonb,   -- { run_stop_id: 지나간 시각 }
  unique (run_id, day)
);
-- 지나온 길 (지도에 진하게 표시). 7일 지나면 지움
create table if not exists public.shuttle_points (
  id bigint generated always as identity primary key,
  trip_id uuid not null references public.shuttle_trips on delete cascade,
  lat double precision not null,
  lng double precision not null,
  at timestamptz not null default now()
);
create index if not exists shuttle_points_trip_idx on public.shuttle_points (trip_id, at);

alter table public.shuttle_trips enable row level security;
alter table public.shuttle_points enable row level security;
grant select, insert, update, delete on public.shuttle_trips, public.shuttle_points to authenticated, service_role;

-- 이 운행에 우리 아이가 타는지 (학부모는 우리 아이가 타는 운행만 볼 수 있음)
create or replace function public.is_my_run(p_run uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.ride_assignments ra join public.run_stops rs on rs.id = ra.run_stop_id
     where rs.run_id = p_run and public.is_my_child(ra.student_id))
$$;
grant execute on function public.is_my_run(uuid) to authenticated;

drop policy if exists trip_staff on public.shuttle_trips;
create policy trip_staff on public.shuttle_trips for all to authenticated
  using (org_id = public.my_org() and public.is_staff()) with check (org_id = public.my_org() and public.is_staff());
drop policy if exists trip_parent on public.shuttle_trips;
create policy trip_parent on public.shuttle_trips for select to authenticated
  using (org_id = public.my_org() and public.is_my_run(run_id));
drop policy if exists point_read on public.shuttle_points;
create policy point_read on public.shuttle_points for select to authenticated
  using (exists (select 1 from public.shuttle_trips t where t.id = trip_id and t.org_id = public.my_org()
                 and (public.is_staff() or public.is_my_run(t.run_id))));

-- 두 지점 사이 거리(m)
create or replace function public.geo_m(a_lat double precision, a_lng double precision, b_lat double precision, b_lng double precision)
returns double precision language sql immutable as $$
  select 6371000 * 2 * asin(sqrt(
    power(sin(radians(b_lat - a_lat) / 2), 2) +
    cos(radians(a_lat)) * cos(radians(b_lat)) * power(sin(radians(b_lng - a_lng) / 2), 2)))
$$;

-- 기사님 폰이 몇 초마다 보내는 위치. 정류장 70m 안에 들어오면 "지나감" 표시
create or replace function public.shuttle_ping(p_trip uuid, p_lat double precision, p_lng double precision, p_speed real default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare t record; last record; s record; v_passed jsonb;
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  select * into t from public.shuttle_trips where id = p_trip and org_id = public.my_org();
  if t.id is null or t.ended_at is not null then return jsonb_build_object('error', 'not_running'); end if;
  v_passed := t.passed;
  for s in
    select rs.id, st.lat, st.lng from public.run_stops rs join public.stops st on st.id = rs.stop_id
     where rs.run_id = t.run_id and st.lat is not null
  loop
    if not (v_passed ? s.id::text) and public.geo_m(p_lat, p_lng, s.lat, s.lng) < 70 then
      v_passed := v_passed || jsonb_build_object(s.id::text, now());
    end if;
  end loop;
  update public.shuttle_trips set lat = p_lat, lng = p_lng, speed = p_speed, pos_at = now(), passed = v_passed where id = p_trip;
  -- 지나온 길: 20m 이상 움직였을 때만 저장
  select lat, lng into last from public.shuttle_points where trip_id = p_trip order by at desc limit 1;
  if last.lat is null or public.geo_m(last.lat, last.lng, p_lat, p_lng) > 20 then
    insert into public.shuttle_points (trip_id, lat, lng) values (p_trip, p_lat, p_lng);
  end if;
  return jsonb_build_object('ok', true, 'passed', v_passed);
end $$;
grant execute on function public.shuttle_ping(uuid, double precision, double precision, real) to authenticated;

-- 오래된 위치 기록 정리 (매일 새벽)
do $$
begin
  perform cron.unschedule('kangcheol-shuttle-cleanup');
exception when others then null;
end $$;
do $$
begin
  perform cron.schedule('kangcheol-shuttle-cleanup', '30 18 * * *',
    $c$delete from public.shuttle_points where at < now() - interval '7 days'$c$);
exception when others then null;
end $$;

do $$
begin
  begin
    alter publication supabase_realtime add table public.shuttle_trips;
  exception when duplicate_object then null;
  end;
end $$;

-- 학부모가 도장 위치를 볼 수 있게
drop function if exists public.org_place();
create function public.org_place() returns table (name text, lat double precision, lng double precision)
language sql stable security definer set search_path = public as $$
  select name, lat, lng from public.orgs where id = public.my_org()
$$;
grant execute on function public.org_place() to authenticated;
notify pgrst, 'reload schema';
