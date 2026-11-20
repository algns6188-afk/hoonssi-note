-- 강철노트 v23: 운행을 "기기"로 시작 + 자동 운행은 마지막으로 GPS 잡았던 기기 기준
-- schema-v22-vehicle-devices.sql 다음에 실행. 여러 번 실행해도 안전합니다.
--
-- · 직접 시작: 고른 기기의 위치만 그 운행에 씀 (다른 폰 위치는 버림)
-- · 자동 시작: 그 차량에서 마지막으로 위치를 보냈던 기기(최근 3분 안에 신호가 있으면)로 시작.
--   그 기기 신호가 3분 넘게 끊기면 위치를 보내는 다른 허용 기기로 넘어감
-- · 기기 켬/끔은 이제 "위치 허용/비허용" (여러 대 허용 가능)

alter table public.shuttle_trips add column if not exists device_id uuid references public.vehicle_devices on delete set null;
alter table public.vehicles add column if not exists last_device_id uuid references public.vehicle_devices on delete set null;

/* 기기 위치 허용/비허용 (다른 기기는 건드리지 않음) */
create or replace function public.set_device_enabled(p_device uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  update public.vehicle_devices set enabled = p_on where id = p_device and org_id = public.my_org();
  if not found then raise exception 'not found'; end if;
end $$;
grant execute on function public.set_device_enabled(uuid, boolean) to authenticated;

/* 관리자: 운행 직접 시작 (기기 지정) */
drop function if exists public.trip_start(uuid);
create or replace function public.trip_start(p_run uuid, p_device uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_day date := (now() at time zone 'Asia/Seoul')::date; v_org uuid; v_id uuid; t record; d record;
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  select org_id into v_org from public.runs where id = p_run and org_id = public.my_org();
  if v_org is null then raise exception 'not found'; end if;
  if p_device is not null then
    select * into d from public.vehicle_devices where id = p_device and org_id = v_org;
    if d.id is null then raise exception 'device not found'; end if;
    update public.vehicle_devices set enabled = true where id = d.id;          -- 고른 기기는 위치 허용
    update public.vehicles set last_device_id = d.id where id = d.vehicle_id;
  end if;
  -- 같은 차량의 다른 운행은 끝냄
  for t in select st.id from public.shuttle_trips st join public.runs a on a.id = st.run_id join public.runs b on b.id = p_run
            where st.org_id = v_org and st.ended_at is null and st.run_id <> p_run
              and (a.vehicle_id is null or b.vehicle_id is null or a.vehicle_id = b.vehicle_id) loop
    perform public.end_trip(t.id);
  end loop;
  insert into public.shuttle_trips (org_id, run_id, day, driver, manual, device_id) values (v_org, p_run, v_day, auth.uid(), true, p_device)
  on conflict (run_id, day) do update set ended_at = null, manual = true, started_at = now(), device_id = p_device
  returning id into v_id;
  return v_id;
end $$;
grant execute on function public.trip_start(uuid, uuid) to authenticated;

/* 그 기기 신호가 최근에 있었는지 (지금 보내는 기기는 빼고 판단) */
create or replace function public.device_alive(p_device uuid, p_except uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.vehicle_devices
                  where id = p_device and id is distinct from p_except and enabled and last_at > now() - interval '3 minutes')
$$;
revoke all on function public.device_alive(uuid, uuid) from public, anon, authenticated;

/* 차량 위치 처리: p_device = 위치를 보낸 기기 (예전 방식은 null) */
drop function if exists public.shuttle_vehicle_ping(uuid, double precision, double precision, real);
create or replace function public.shuttle_vehicle_ping(p_vehicle uuid, p_lat double precision, p_lng double precision, p_speed real, p_device uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v record; r record; cur record; tr record;
  v_day date := (now() at time zone 'Asia/Seoul')::date;
  v_dow text := substr('일월화수목금토', extract(dow from (now() at time zone 'Asia/Seoul'))::int + 1, 1);
  v_run uuid;
begin
  select * into v from public.vehicles where id = p_vehicle and active;
  if v.id is null then return jsonb_build_object('error', 'unknown_vehicle'); end if;
  update public.vehicles set gps_last_at = now() where id = v.id;

  -- 1) 직접 시작한 운행: 고른 기기 위치만
  select t.* into tr from public.shuttle_trips t join public.runs ru on ru.id = t.run_id
   where t.org_id = v.org_id and t.ended_at is null and t.manual and (ru.vehicle_id is null or ru.vehicle_id = v.id)
   order by t.started_at desc limit 1;
  if tr.id is not null then
    if p_device is not null and tr.device_id is not null and tr.device_id <> p_device then
      return jsonb_build_object('ok', true, 'ignored', 'other_device', 'run', tr.run_id);
    end if;
    if p_device is not null then
      if tr.device_id is null then update public.shuttle_trips set device_id = p_device where id = tr.id; end if;
      update public.vehicles set last_device_id = p_device where id = v.id;
    end if;
    return public.shuttle_ping_core(tr.id, p_lat, p_lng, p_speed) || jsonb_build_object('run', tr.run_id, 'manual', true);
  end if;

  -- 2) 차량표 시간대 운행 (자동)
  for r in
    select ru.id, w.starts from public.runs ru, lateral public.run_window(ru.id, v_day) w
     where ru.org_id = v.org_id and ru.active and (ru.vehicle_id is null or ru.vehicle_id = v.id)
       and v_dow = any (string_to_array(ru.weekdays, ','))
       and w.starts is not null and now() between w.starts and w.ends
     order by w.starts desc limit 1
  loop
    v_run := r.id;
  end loop;

  for cur in
    select t.id from public.shuttle_trips t join public.runs ru on ru.id = t.run_id
     where t.org_id = v.org_id and t.ended_at is null and not t.manual
       and (ru.vehicle_id is null or ru.vehicle_id = v.id) and t.run_id is distinct from v_run
  loop
    perform public.end_trip(cur.id);
  end loop;

  if v_run is null then return jsonb_build_object('ok', true, 'run', null, 'ignored', true); end if;

  select * into tr from public.shuttle_trips where run_id = v_run and day = v_day;
  if tr.id is not null and tr.ended_at is not null then return jsonb_build_object('ok', true, 'run', v_run, 'ended', true); end if;

  if p_device is not null then
    if tr.id is not null and tr.device_id is not null and tr.device_id <> p_device then
      -- 운행을 맡은 기기가 살아 있으면 이 기기 위치는 버림, 3분 넘게 끊겼으면 이 기기로 넘김
      if public.device_alive(tr.device_id, p_device) then
        return jsonb_build_object('ok', true, 'ignored', 'other_device', 'run', v_run);
      end if;
    elsif tr.id is null and v.last_device_id is not null and v.last_device_id <> p_device
          and public.device_alive(v.last_device_id, p_device) then
      -- 아직 시작 전: 마지막으로 GPS 잡았던 기기가 신호를 보내고 있으면 그 기기로 시작되게 기다림
      return jsonb_build_object('ok', true, 'ignored', 'other_device', 'run', v_run);
    end if;
  end if;

  if tr.id is null then
    insert into public.shuttle_trips (org_id, run_id, day, driver, manual, device_id) values (v.org_id, v_run, v_day, null, false, p_device)
    on conflict (run_id, day) do nothing
    returning * into tr;
    if tr.id is null then select * into tr from public.shuttle_trips where run_id = v_run and day = v_day; end if;
  end if;
  if p_device is not null then
    if tr.device_id is distinct from p_device then update public.shuttle_trips set device_id = p_device where id = tr.id; end if;
    update public.vehicles set last_device_id = p_device where id = v.id;
  end if;
  return public.shuttle_ping_core(tr.id, p_lat, p_lng, p_speed) || jsonb_build_object('run', v_run);
end $$;
revoke all on function public.shuttle_vehicle_ping(uuid, double precision, double precision, real, uuid) from public, anon, authenticated;

/* Traccar 앱에서 온 위치 */
create or replace function public.shuttle_device_ping(p_token text, p_lat double precision, p_lng double precision, p_speed real default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare d record; v_vehicle uuid;
begin
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
  select * into d from public.vehicle_devices where token = p_token and org_id = public.my_org();
  if d.id is null then return jsonb_build_object('error', 'unknown_device'); end if;
  if not d.enabled then return jsonb_build_object('ok', true, 'ignored', 'device_off'); end if;
  update public.vehicle_devices set last_at = now() where id = d.id;
  return public.shuttle_vehicle_ping(d.vehicle_id, p_lat, p_lng, p_speed, d.id);
end $$;
grant execute on function public.shuttle_web_ping(text, double precision, double precision, real) to authenticated;

-- 지금까지 위치가 가장 최근에 온 기기를 "마지막 GPS 기기"로
update public.vehicles v set last_device_id = (
  select d.id from public.vehicle_devices d where d.vehicle_id = v.id and d.last_at is not null order by d.last_at desc limit 1)
 where v.last_device_id is null;
notify pgrst, 'reload schema';
