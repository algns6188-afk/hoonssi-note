-- 강철노트 v19: 운행 자동 시작(차량표 5분 전)·자동 종료(10분 후) + 직접 시작/종료, 운행 시간 밖 위치는 저장·공유 안 함
-- schema-v18-gps-device.sql 다음에 실행. 여러 번 실행해도 안전합니다.

alter table public.shuttle_trips add column if not exists manual boolean not null default false;   -- 관리자가 직접 시작한 운행

/* 운행 시간대: 첫 정류장 5분 전 ~ 마지막 정류장 10분 뒤 (그 요일 정류장 기준) */
create or replace function public.run_window(p_run uuid, p_day date)
returns table (starts timestamptz, ends timestamptz)
language sql stable security definer set search_path = public as $$
  select (p_day + min(rs.at_time)) at time zone 'Asia/Seoul' - interval '5 minutes',
         (p_day + max(rs.at_time)) at time zone 'Asia/Seoul' + interval '10 minutes'
    from public.run_stops rs
   where rs.run_id = p_run
     and (rs.weekdays is null or substr('일월화수목금토', extract(dow from p_day)::int + 1, 1) = any (string_to_array(rs.weekdays, ',')))
$$;

/* 운행 끝내기: 끝나면 마지막 위치도 지움 (운행 시간 밖에는 위치 공유 안 함) */
create or replace function public.end_trip(p_trip uuid) returns void
language sql security definer set search_path = public as $$
  update public.shuttle_trips set ended_at = coalesce(ended_at, now()), lat = null, lng = null, speed = null where id = p_trip
$$;
revoke all on function public.end_trip(uuid) from public, anon, authenticated;

/* GPS 앱 위치 처리
   1) 관리자가 직접 시작한 운행이 있으면 그 운행에 기록 (시간 상관없이, 직접 끌 때까지)
   2) 없으면 차량표 시간대(5분 전 ~ 10분 후)에 맞는 운행을 자동 시작
   3) 어느 운행 시간도 아니면 위치를 버림 (저장·공유 안 함) */
create or replace function public.shuttle_device_ping(p_token text, p_lat double precision, p_lng double precision, p_speed real default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v record; r record; cur record; tr record;
  v_day date := (now() at time zone 'Asia/Seoul')::date;
  v_dow text := substr('일월화수목금토', extract(dow from (now() at time zone 'Asia/Seoul'))::int + 1, 1);
  v_run uuid;
begin
  if coalesce(length(p_token), 0) < 12 then return jsonb_build_object('error', 'bad_token'); end if;
  select * into v from public.vehicles where gps_token = p_token and active;
  if v.id is null then return jsonb_build_object('error', 'unknown_device'); end if;
  update public.vehicles set gps_last_at = now() where id = v.id;   -- 시각만 (위치 아님): 앱 연결 확인용

  -- 1) 직접 시작한 운행
  select t.* into tr from public.shuttle_trips t join public.runs ru on ru.id = t.run_id
   where t.org_id = v.org_id and t.ended_at is null and t.manual and (ru.vehicle_id is null or ru.vehicle_id = v.id)
   order by t.started_at desc limit 1;
  if tr.id is not null then
    return public.shuttle_ping_core(tr.id, p_lat, p_lng, p_speed) || jsonb_build_object('run', tr.run_id, 'manual', true);
  end if;

  -- 2) 지금 시간대의 운행 (겹치면 더 늦게 시작한 것)
  for r in
    select ru.id, w.starts from public.runs ru, lateral public.run_window(ru.id, v_day) w
     where ru.org_id = v.org_id and ru.active and (ru.vehicle_id is null or ru.vehicle_id = v.id)
       and v_dow = any (string_to_array(ru.weekdays, ','))
       and w.starts is not null and now() between w.starts and w.ends
     order by w.starts desc limit 1
  loop
    v_run := r.id;
  end loop;

  -- 시간대가 지난 자동 운행은 끝냄
  for cur in
    select t.id from public.shuttle_trips t join public.runs ru on ru.id = t.run_id
     where t.org_id = v.org_id and t.ended_at is null and not t.manual
       and (ru.vehicle_id is null or ru.vehicle_id = v.id) and t.run_id is distinct from v_run
  loop
    perform public.end_trip(cur.id);
  end loop;

  -- 3) 운행 시간 밖: 위치를 버림
  if v_run is null then return jsonb_build_object('ok', true, 'run', null, 'ignored', true); end if;

  select * into tr from public.shuttle_trips where run_id = v_run and day = v_day;
  if tr.id is null then
    insert into public.shuttle_trips (org_id, run_id, day, driver, manual) values (v.org_id, v_run, v_day, null, false)
    on conflict (run_id, day) do nothing
    returning * into tr;
    if tr.id is null then select * into tr from public.shuttle_trips where run_id = v_run and day = v_day; end if;
  end if;
  if tr.ended_at is not null then return jsonb_build_object('ok', true, 'run', v_run, 'ended', true); end if;  -- 직접 끝낸 운행은 다시 안 엶
  return public.shuttle_ping_core(tr.id, p_lat, p_lng, p_speed) || jsonb_build_object('run', v_run);
end $$;
revoke all on function public.shuttle_device_ping(text, double precision, double precision, real) from public, anon, authenticated;
grant execute on function public.shuttle_device_ping(text, double precision, double precision, real) to service_role;

/* 관리자: 운행 직접 시작 / 직접 종료 */
create or replace function public.trip_start(p_run uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_day date := (now() at time zone 'Asia/Seoul')::date; v_org uuid; v_id uuid; t record;
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  select org_id into v_org from public.runs where id = p_run and org_id = public.my_org();
  if v_org is null then raise exception 'not found'; end if;
  -- 같은 차량의 다른 운행은 끝냄
  for t in select st.id from public.shuttle_trips st join public.runs a on a.id = st.run_id join public.runs b on b.id = p_run
            where st.org_id = v_org and st.ended_at is null and st.run_id <> p_run
              and (a.vehicle_id is null or b.vehicle_id is null or a.vehicle_id = b.vehicle_id) loop
    perform public.end_trip(t.id);
  end loop;
  insert into public.shuttle_trips (org_id, run_id, day, driver, manual) values (v_org, p_run, v_day, auth.uid(), true)
  on conflict (run_id, day) do update set ended_at = null, manual = true, started_at = now()
  returning id into v_id;
  return v_id;
end $$;
grant execute on function public.trip_start(uuid) to authenticated;

create or replace function public.trip_end(p_run uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t record;
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  for t in select id from public.shuttle_trips where run_id = p_run and org_id = public.my_org() and ended_at is null loop
    perform public.end_trip(t.id);
  end loop;
end $$;
grant execute on function public.trip_end(uuid) to authenticated;

-- 매분: 자동 운행은 마지막 정류장 10분 뒤 종료, 직접 시작한 운행은 위치가 30분 넘게 안 오면 종료
do $$
begin
  perform cron.unschedule('kangcheol-shuttle-autoend');
exception when others then null;
end $$;
do $$
begin
  perform cron.schedule('kangcheol-shuttle-autoend', '* * * * *', $c$
    select public.end_trip(t.id) from public.shuttle_trips t, lateral public.run_window(t.run_id, t.day) w
     where t.ended_at is null and not t.manual and w.ends is not null and now() > w.ends;
    select public.end_trip(t.id) from public.shuttle_trips t
     where t.ended_at is null and t.manual and t.started_at < now() - interval '30 minutes'
       and coalesce(t.pos_at, t.started_at) < now() - interval '30 minutes';
  $c$);
exception when others then null;
end $$;
-- 이미 끝난 운행에 남은 마지막 위치 지우기
update public.shuttle_trips set lat = null, lng = null, speed = null where ended_at is not null and lat is not null;
notify pgrst, 'reload schema';
