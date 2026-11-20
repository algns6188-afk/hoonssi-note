-- 강철노트 v25: 잘못된 위치(위도·경도 0 근처 = GPS를 못 잡은 신호, 범위 밖 값)는 버리기
-- schema-v24-dojang-arrive.sql 다음에 실행. 여러 번 실행해도 안전합니다.
-- Traccar 앱이 GPS를 못 잡거나 추적을 끌 때 (0, 0)을 보내는 경우가 있어 차량 위치가 엉뚱하게 저장되는 것을 막음

create or replace function public.bad_fix(p_lat double precision, p_lng double precision) returns boolean
language sql immutable as $$
  select p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 or (abs(p_lat) < 1 and abs(p_lng) < 1)
$$;

create or replace function public.shuttle_ping_core(p_trip uuid, p_lat double precision, p_lng double precision, p_speed real)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare t record; last record; s record; v_passed jsonb; o record; v_kind text;
begin
  if public.bad_fix(p_lat, p_lng) then return jsonb_build_object('ok', true, 'ignored', 'bad_location'); end if;
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

  -- 태권도장 도착 (등원 쪽 운행, 정류장을 하나라도 지난 뒤)
  select kind into v_kind from public.runs where id = t.run_id;
  if v_kind in ('to', 'mixed') and not (v_passed ? 'dojang_arrived')
     and exists (select 1 from jsonb_object_keys(v_passed) k where k <> 'dojang_arrived') then
    select lat, lng into o from public.orgs where id = t.org_id;
    if o.lat is not null and public.geo_m(p_lat, p_lng, o.lat, o.lng) < 80 then
      v_passed := v_passed || jsonb_build_object('dojang_arrived', now());
    end if;
  end if;

  update public.shuttle_trips set lat = p_lat, lng = p_lng, speed = p_speed, pos_at = now(), passed = v_passed where id = p_trip;
  select lat, lng into last from public.shuttle_points where trip_id = p_trip order by at desc limit 1;
  if last.lat is null or public.geo_m(last.lat, last.lng, p_lat, p_lng) > 20 then
    insert into public.shuttle_points (trip_id, lat, lng) values (p_trip, p_lat, p_lng);
  end if;
  return jsonb_build_object('ok', true, 'passed', v_passed);
end $$;
revoke all on function public.shuttle_ping_core(uuid, double precision, double precision, real) from public, anon, authenticated;

/* Traccar 앱에서 온 위치 */
create or replace function public.shuttle_device_ping(p_token text, p_lat double precision, p_lng double precision, p_speed real default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare d record; v_vehicle uuid;
begin
  if public.bad_fix(p_lat, p_lng) then return jsonb_build_object('ok', true, 'ignored', 'bad_location'); end if;
  if coalesce(length(p_token), 0) < 12 then return jsonb_build_object('error', 'bad_token'); end if;
  select * into d from public.vehicle_devices where token = p_token;
  if d.id is null then
    select id into v_vehicle from public.vehicles where gps_token = p_token and active;   -- 예전 방식
    if v_vehicle is null then return jsonb_build_object('error', 'unknown_device'); end if;
    return public.shuttle_vehicle_ping(v_vehicle, p_lat, p_lng, p_speed, null);
  end if;
  if not d.enabled then return jsonb_build_object('ok', true, 'ignored', 'device_off'); end if;   -- 비허용 기기: 위치 버림
  update public.vehicle_devices set last_at = now() where id = d.id;
  return public.shuttle_vehicle_ping(d.vehicle_id, p_lat, p_lng, p_speed, d.id);
end $$;
revoke all on function public.shuttle_device_ping(text, double precision, double precision, real) from public, anon, authenticated;
grant execute on function public.shuttle_device_ping(text, double precision, double precision, real) to service_role;

/* 강철노트 화면(웹)에서 보내는 위치 */
create or replace function public.shuttle_web_ping(p_token text, p_lat double precision, p_lng double precision, p_speed real default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare d record;
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  if public.bad_fix(p_lat, p_lng) then return jsonb_build_object('ok', true, 'ignored', 'bad_location'); end if;
  select * into d from public.vehicle_devices where token = p_token and org_id = public.my_org();
  if d.id is null then return jsonb_build_object('error', 'unknown_device'); end if;
  if not d.enabled then return jsonb_build_object('ok', true, 'ignored', 'device_off'); end if;
  update public.vehicle_devices set last_at = now() where id = d.id;
  return public.shuttle_vehicle_ping(d.vehicle_id, p_lat, p_lng, p_speed, d.id);
end $$;
grant execute on function public.shuttle_web_ping(text, double precision, double precision, real) to authenticated;

-- 이미 저장된 (0, 0) 위치 지우기
delete from public.shuttle_points where abs(lat) < 1 and abs(lng) < 1;
update public.shuttle_trips set lat = null, lng = null, speed = null where abs(lat) < 1 and abs(lng) < 1;
notify pgrst, 'reload schema';
