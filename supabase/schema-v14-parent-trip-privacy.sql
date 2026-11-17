-- 강철노트 v14: 학부모는 "우리 아이가 타는 동안"만 차량 진행을 볼 수 있게 (GPS 좌표는 학부모에게 아예 안 보냄)
-- schema-v13-ride-requests.sql 다음에 실행. 여러 번 실행해도 안전합니다.

-- 학부모가 운행 기록(좌표 포함)·지나온 길을 직접 읽던 권한 제거 → 관리자·선생님만
drop policy if exists trip_parent on public.shuttle_trips;
drop policy if exists point_read on public.shuttle_points;
create policy point_read on public.shuttle_points for select to authenticated
  using (exists (select 1 from public.shuttle_trips t where t.id = trip_id and t.org_id = public.my_org() and public.is_staff()));

-- 학부모용: 오늘 우리 아이가 타는 운행의 진행 상황만 (좌표 없음)
--  kid_done = 우리 아이 정류장을 모두 지났거나 운행이 끝남 → 그 뒤로는 차량 위치를 안 보여 줌
create or replace function public.parent_trips()
returns table (run_id uuid, started_at timestamptz, ended_at timestamptz, passed jsonb, kid_done boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  v_day date := (now() at time zone 'Asia/Seoul')::date;
  v_dow text := substr('일월화수목금토', extract(dow from (now() at time zone 'Asia/Seoul'))::int + 1, 1);
begin
  return query
  with mine as (
    -- 오늘 우리 아이가 실제로 타는 정류장 (요일 맞고, 그날 "안 탐"이 아닌 것 + 그날 추가된 것)
    select rs.run_id, rs.id as rs_id
      from public.ride_assignments ra
      join public.run_stops rs on rs.id = ra.run_stop_id
      join public.runs r on r.id = rs.run_id
     where public.is_my_child(ra.student_id)
       and v_dow = any (string_to_array(coalesce(ra.weekdays, rs.weekdays, r.weekdays), ','))
       and not exists (select 1 from public.ride_exceptions e
                        where e.date = v_day and e.run_stop_id = rs.id and e.student_id = ra.student_id and e.type = 'skip')
    union
    select rs.run_id, e.run_stop_id
      from public.ride_exceptions e join public.run_stops rs on rs.id = e.run_stop_id
     where e.date = v_day and e.type = 'add' and public.is_my_child(e.student_id)
  )
  select t.run_id, t.started_at, t.ended_at, t.passed,
         (t.ended_at is not null or not exists (
            select 1 from mine m where m.run_id = t.run_id and not (t.passed ? m.rs_id::text))) as kid_done
    from public.shuttle_trips t
   where t.day = v_day and t.org_id = public.my_org()
     and exists (select 1 from mine m where m.run_id = t.run_id);
end $$;
revoke all on function public.parent_trips() from public;
grant execute on function public.parent_trips() to authenticated;
notify pgrst, 'reload schema';
