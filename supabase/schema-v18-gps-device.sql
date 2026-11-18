-- 강철노트 v18: GPS 앱(Traccar Client) 연결 — 화면이 꺼져도 위치 전송, 시간표로 운행 자동 시작·종료
-- schema-v17-shuttle-areas.sql 다음에 실행. 여러 번 실행해도 안전합니다.

alter table public.vehicles add column if not exists gps_token text;          -- Traccar "기기 식별자" (비밀번호처럼 길고 무작위)
alter table public.vehicles add column if not exists gps_last_at timestamptz; -- 마지막으로 위치 받은 시각
do $$
begin
  create unique index vehicles_gps_token_idx on public.vehicles (gps_token) where gps_token is not null;
exception when duplicate_table then null;
end $$;

/* 위치 한 번 처리 (정류장 70m 안 → 지남 표시, 지나온 길 저장). 직원 화면·GPS 앱 공통 */
create or replace function public.shuttle_ping_core(p_trip uuid, p_lat double precision, p_lng double precision, p_speed real)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare t record; last record; s record; v_passed jsonb;
begin
  select * into t from public.shuttle_trips where id = p_trip;
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
  select lat, lng into last from public.shuttle_points where trip_id = p_trip order by at desc limit 1;
  if last.lat is null or public.geo_m(last.lat, last.lng, p_lat, p_lng) > 20 then
    insert into public.shuttle_points (trip_id, lat, lng) values (p_trip, p_lat, p_lng);
  end if;
  return jsonb_build_object('ok', true, 'passed', v_passed);
end $$;
revoke all on function public.shuttle_ping_core(uuid, double precision, double precision, real) from public, anon, authenticated;

-- 직원 화면(웹앱 운행 모드)용은 그대로, 안쪽만 공통 함수 사용
create or replace function public.shuttle_ping(p_trip uuid, p_lat double precision, p_lng double precision, p_speed real default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.shuttle_trips where id = p_trip and org_id = public.my_org()) then
    return jsonb_build_object('error', 'not_running');
  end if;
  return public.shuttle_ping_core(p_trip, p_lat, p_lng, p_speed);
end $$;
grant execute on function public.shuttle_ping(uuid, double precision, double precision, real) to authenticated;

/* 그날 운행 시간대: 첫 정류장 20분 전 ~ 마지막 정류장 30분 뒤 (그 요일 정류장 기준) */
create or replace function public.run_window(p_run uuid, p_day date)
returns table (starts timestamptz, ends timestamptz)
language sql stable security definer set search_path = public as $$
  select (p_day + min(rs.at_time)) at time zone 'Asia/Seoul' - interval '20 minutes',
         (p_day + max(rs.at_time)) at time zone 'Asia/Seoul' + interval '30 minutes'
    from public.run_stops rs
   where rs.run_id = p_run
     and (rs.weekdays is null or substr('일월화수목금토', extract(dow from p_day)::int + 1, 1) = any (string_to_array(rs.weekdays, ',')))
$$;

/* GPS 앱에서 온 위치: 차량 확인 → 지금 시간에 맞는 운행 자동 시작/종료 → 위치 처리
   서버 함수(gps)만 부를 수 있음 (service_role) */
create or replace function public.shuttle_device_ping(p_token text, p_lat double precision, p_lng double precision, p_speed real default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v record; r record; cur record; tr record;
  v_day date := (now() at time zone 'Asia/Seoul')::date;
  v_dow text := substr('일월화수목금토', extract(dow from (now() at time zone 'Asia/Seoul'))::int + 1, 1);
  v_run uuid; v_start timestamptz;
begin
  if coalesce(length(p_token), 0) < 12 then return jsonb_build_object('error', 'bad_token'); end if;
  select * into v from public.vehicles where gps_token = p_token and active;
  if v.id is null then return jsonb_build_object('error', 'unknown_device'); end if;
  update public.vehicles set gps_last_at = now() where id = v.id;

  -- 지금 시간대에 해당하는 운행 (겹치면 더 늦게 시작한 것)
  for r in
    select ru.id, w.starts, w.ends from public.runs ru, lateral public.run_window(ru.id, v_day) w
     where ru.org_id = v.org_id and ru.active and (ru.vehicle_id is null or ru.vehicle_id = v.id)
       and v_dow = any (string_to_array(ru.weekdays, ','))
       and w.starts is not null and now() between w.starts and w.ends
     order by w.starts desc limit 1
  loop
    v_run := r.id; v_start := r.starts;
  end loop;

  -- 다른 운행이 아직 "운행 중"이면 끝냄 (시간대가 지났거나 다음 운행으로 넘어감)
  for cur in
    select t.id, t.run_id from public.shuttle_trips t join public.runs ru on ru.id = t.run_id
     where t.org_id = v.org_id and t.day = v_day and t.ended_at is null
       and (ru.vehicle_id is null or ru.vehicle_id = v.id) and t.run_id is distinct from v_run
  loop
    update public.shuttle_trips set ended_at = now() where id = cur.id;
  end loop;

  if v_run is null then return jsonb_build_object('ok', true, 'run', null); end if;

  select * into tr from public.shuttle_trips where run_id = v_run and day = v_day;
  if tr.id is null then
    insert into public.shuttle_trips (org_id, run_id, day, driver) values (v.org_id, v_run, v_day, null)
    on conflict (run_id, day) do nothing
    returning * into tr;
    if tr.id is null then select * into tr from public.shuttle_trips where run_id = v_run and day = v_day; end if;
  end if;
  if tr.ended_at is not null then return jsonb_build_object('ok', true, 'run', v_run, 'ended', true); end if;  -- 직원이 끝낸 운행은 다시 안 엶
  return public.shuttle_ping_core(tr.id, p_lat, p_lng, p_speed) || jsonb_build_object('run', v_run);
end $$;
revoke all on function public.shuttle_device_ping(text, double precision, double precision, real) from public, anon, authenticated;
grant execute on function public.shuttle_device_ping(text, double precision, double precision, real) to service_role;

-- 오래 안 끝난 운행 정리: 위치가 안 와도 시간대가 지나면 끝냄 (10분마다)
do $$
begin
  perform cron.unschedule('kangcheol-shuttle-autoend');
exception when others then null;
end $$;
do $$
begin
  perform cron.schedule('kangcheol-shuttle-autoend', '*/10 * * * *', $c$
    update public.shuttle_trips t set ended_at = now()
      from lateral public.run_window(t.run_id, t.day) w
     where t.ended_at is null and w.ends is not null and now() > w.ends + interval '30 minutes'
  $c$);
exception when others then null;
end $$;
notify pgrst, 'reload schema';
