-- 강철노트 v20: 하원 운행은 그 부 수업 끝나기 5분 전에 자동 시작
-- schema-v19-trip-auto-manual.sql 다음에 실행. 여러 번 실행해도 안전합니다.
--  1부 14:00~15:00 → 하원 운행 14:55 시작 / 2부 15:30~16:30 → 16:25 / 3부 17:00~18:00 → 17:55
--  4부 18:00~19:00 → 18:55 / 5부 19:00~21:00 → 20:55 / 6부 21:00~22:00 → 21:55
--  등원 운행은 그대로 첫 정류장 5분 전, 종료는 모두 마지막 정류장 10분 뒤

create or replace function public.session_end(p_no int) returns time
language sql immutable as $$
  select case p_no when 1 then time '15:00' when 2 then time '16:30' when 3 then time '18:00'
                   when 4 then time '19:00' when 5 then time '21:00' when 6 then time '22:00' end
$$;

create or replace function public.run_window(p_run uuid, p_day date)
returns table (starts timestamptz, ends timestamptz)
language sql stable security definer set search_path = public as $$
  select case
           when r.kind in ('from', 'mixed') and public.session_end(r.session_no) is not null
             then least((p_day + public.session_end(r.session_no)) at time zone 'Asia/Seoul',
                        (p_day + min(rs.at_time)) at time zone 'Asia/Seoul') - interval '5 minutes'
           else (p_day + min(rs.at_time)) at time zone 'Asia/Seoul' - interval '5 minutes'
         end,
         (p_day + max(rs.at_time)) at time zone 'Asia/Seoul' + interval '10 minutes'
    from public.runs r join public.run_stops rs on rs.run_id = r.id
   where r.id = p_run
     and (rs.weekdays is null or substr('일월화수목금토', extract(dow from p_day)::int + 1, 1) = any (string_to_array(rs.weekdays, ',')))
   group by r.kind, r.session_no
$$;
notify pgrst, 'reload schema';
