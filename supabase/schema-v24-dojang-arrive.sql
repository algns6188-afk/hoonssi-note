-- 강철노트 v24: 등원 운행 마지막 "태권도장 도착"도 GPS로 잡기
-- schema-v23-trip-device.sql 다음에 실행. 여러 번 실행해도 안전합니다.
-- 등원(to)·하원+등원(mixed) 운행에서 정류장을 하나 이상 지난 뒤 도장 80m 안에 들어오면
-- passed 에 "dojang_arrived" 를 기록 → 노선도·지도에서 차 모양이 도장으로 이동

create or replace function public.shuttle_ping_core(p_trip uuid, p_lat double precision, p_lng double precision, p_speed real)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare t record; last record; s record; v_passed jsonb; o record; v_kind text;
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
notify pgrst, 'reload schema';
