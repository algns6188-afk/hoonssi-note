-- 강철노트 v22: 차량마다 위치 보내는 기기(폰) 여러 대 등록 + 기기별 위치 받기 켬/끔
-- schema-v21-cash-receipt.sql 다음에 실행. 여러 번 실행해도 안전합니다.

create table if not exists public.vehicle_devices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  vehicle_id uuid not null references public.vehicles on delete cascade,
  name text not null default '',                    -- 도장 아이폰, 기사님 갤럭시 …
  kind text not null check (kind in ('app', 'web')), -- app = Traccar Client 앱(화면 꺼져도 됨), web = 강철노트 화면
  token text not null unique,                        -- 기기 식별자 (비밀번호처럼 길고 무작위)
  enabled boolean not null default true,             -- 위치 받기 켬/끔
  last_at timestamptz,                               -- 마지막으로 위치 받은 시각 (위치 자체는 저장 안 함)
  created_at timestamptz not null default now()
);
create index if not exists vehicle_devices_vehicle_idx on public.vehicle_devices (vehicle_id);
alter table public.vehicle_devices enable row level security;
grant select, insert, update, delete on public.vehicle_devices to authenticated, service_role;
drop policy if exists device_staff on public.vehicle_devices;
create policy device_staff on public.vehicle_devices for all to authenticated
  using (org_id = public.my_org() and public.is_staff()) with check (org_id = public.my_org() and public.is_staff());

-- 예전에 차량에 넣어 둔 Traccar 식별자 → 기기 목록으로 옮김
insert into public.vehicle_devices (org_id, vehicle_id, name, kind, token, enabled)
select org_id, id, '도장폰 (Traccar 앱)', 'app', gps_token, true from public.vehicles
 where gps_token is not null and length(gps_token) >= 12
on conflict (token) do nothing;

/* 기기 켬/끔: 켜면 같은 차량의 다른 기기는 끔 (위치가 섞이지 않게) */
create or replace function public.set_device_enabled(p_device uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
declare d record;
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  select * into d from public.vehicle_devices where id = p_device and org_id = public.my_org();
  if d.id is null then raise exception 'not found'; end if;
  if p_on then update public.vehicle_devices set enabled = false where vehicle_id = d.vehicle_id and id <> d.id; end if;
  update public.vehicle_devices set enabled = p_on where id = d.id;
end $$;
grant execute on function public.set_device_enabled(uuid, boolean) to authenticated;

/* 차량 위치 처리 (공통): 직접 시작한 운행 → 차량표 시간대 운행 자동 시작 → 운행 시간 밖이면 버림 */
create or replace function public.shuttle_vehicle_ping(p_vehicle uuid, p_lat double precision, p_lng double precision, p_speed real)
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

  select t.* into tr from public.shuttle_trips t join public.runs ru on ru.id = t.run_id
   where t.org_id = v.org_id and t.ended_at is null and t.manual and (ru.vehicle_id is null or ru.vehicle_id = v.id)
   order by t.started_at desc limit 1;
  if tr.id is not null then
    return public.shuttle_ping_core(tr.id, p_lat, p_lng, p_speed) || jsonb_build_object('run', tr.run_id, 'manual', true);
  end if;

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
  if tr.id is null then
    insert into public.shuttle_trips (org_id, run_id, day, driver, manual) values (v.org_id, v_run, v_day, null, false)
    on conflict (run_id, day) do nothing
    returning * into tr;
    if tr.id is null then select * into tr from public.shuttle_trips where run_id = v_run and day = v_day; end if;
  end if;
  if tr.ended_at is not null then return jsonb_build_object('ok', true, 'run', v_run, 'ended', true); end if;
  return public.shuttle_ping_core(tr.id, p_lat, p_lng, p_speed) || jsonb_build_object('run', v_run);
end $$;
revoke all on function public.shuttle_vehicle_ping(uuid, double precision, double precision, real) from public, anon, authenticated;

/* Traccar 앱에서 온 위치 (gps 서버 함수가 부름) */
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
    return public.shuttle_vehicle_ping(v_vehicle, p_lat, p_lng, p_speed);
  end if;
  update public.vehicle_devices set last_at = now() where id = d.id;
  if not d.enabled then return jsonb_build_object('ok', true, 'ignored', 'device_off'); end if;   -- 꺼진 기기: 위치 버림
  return public.shuttle_vehicle_ping(d.vehicle_id, p_lat, p_lng, p_speed);
end $$;
revoke all on function public.shuttle_device_ping(text, double precision, double precision, real) from public, anon, authenticated;
grant execute on function public.shuttle_device_ping(text, double precision, double precision, real) to service_role;

/* 강철노트 화면(웹)에서 보내는 위치: 이 폰이 그 차량의 켜진 기기일 때만 */
create or replace function public.shuttle_web_ping(p_token text, p_lat double precision, p_lng double precision, p_speed real default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare d record;
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  select * into d from public.vehicle_devices where token = p_token and org_id = public.my_org();
  if d.id is null then return jsonb_build_object('error', 'unknown_device'); end if;
  update public.vehicle_devices set last_at = now() where id = d.id;
  if not d.enabled then return jsonb_build_object('ok', true, 'ignored', 'device_off'); end if;
  return public.shuttle_vehicle_ping(d.vehicle_id, p_lat, p_lng, p_speed);
end $$;
grant execute on function public.shuttle_web_ping(text, double precision, double precision, real) to authenticated;
notify pgrst, 'reload schema';
