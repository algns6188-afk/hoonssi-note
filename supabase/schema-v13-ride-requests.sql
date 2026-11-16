-- 강철노트 v13: 학부모 차량 변경 신청 (안 탐 · 탐 · 장소 변경) → 관리자 승인 → 차량표 자동 반영
-- schema-v12-shuttle-live.sql 다음에 실행. 여러 번 실행해도 안전합니다.

create table if not exists public.ride_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  student_id uuid not null references public.students on delete cascade,
  kind text not null check (kind in ('skip', 'add', 'change')),      -- 안 탐 / 탐 / 장소 변경
  scope text not null check (scope in ('once', 'always')),           -- 그날 하루 / 계속(차량표 자체 변경)
  date date,                                                         -- 하루일 때 날짜
  from_run_stop_id uuid references public.run_stops on delete set null,   -- 원래 타던 곳
  to_run_stop_id uuid references public.run_stops on delete set null,     -- 새로 탈 곳
  action text not null default 'board' check (action in ('board', 'alight')),
  weekdays text,                                                     -- 계속 탈 때 요일 (비우면 운행 요일 전체)
  reason text not null default '',
  late boolean not null default false,                               -- 마감 시간 뒤 신청
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'canceled')),
  requested_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  decided_by uuid,
  decided_at timestamptz,
  decide_note text not null default ''
);
create index if not exists ride_requests_org_idx on public.ride_requests (org_id, status, created_at desc);

-- 그날 하루만 바뀐 것 (안 탐 / 추가로 탐)
create table if not exists public.ride_exceptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  date date not null,
  run_stop_id uuid not null references public.run_stops on delete cascade,
  student_id uuid not null references public.students on delete cascade,
  action text not null check (action in ('board', 'alight')),
  type text not null check (type in ('skip', 'add')),
  request_id uuid references public.ride_requests on delete set null,
  note text not null default '',
  created_at timestamptz not null default now(),
  unique (date, run_stop_id, student_id, action, type)
);
create index if not exists ride_exceptions_date_idx on public.ride_exceptions (org_id, date);

alter table public.ride_requests enable row level security;
alter table public.ride_exceptions enable row level security;
grant select, insert, update, delete on public.ride_requests, public.ride_exceptions to authenticated, service_role;

drop policy if exists rreq_staff on public.ride_requests;
create policy rreq_staff on public.ride_requests for all to authenticated
  using (org_id = public.my_org() and public.is_staff()) with check (org_id = public.my_org() and public.is_staff());
drop policy if exists rreq_parent_read on public.ride_requests;
create policy rreq_parent_read on public.ride_requests for select to authenticated using (public.is_my_child(student_id));
drop policy if exists rexc_staff on public.ride_exceptions;
create policy rexc_staff on public.ride_exceptions for all to authenticated
  using (org_id = public.my_org() and public.is_staff()) with check (org_id = public.my_org() and public.is_staff());
drop policy if exists rexc_parent on public.ride_exceptions;
create policy rexc_parent on public.ride_exceptions for select to authenticated using (public.is_my_child(student_id));

/* 그날 운행 출발 시각 (그 요일 첫 정류장 시간) */
create or replace function public.run_departure(p_run uuid, p_date date) returns timestamptz
language sql stable security definer set search_path = public as $$
  select (p_date + min(rs.at_time)) at time zone 'Asia/Seoul'
    from public.run_stops rs join public.runs r on r.id = rs.run_id
   where rs.run_id = p_run
     and (rs.weekdays is null or substr('일월화수목금토', extract(dow from p_date)::int + 1, 1) = any (string_to_array(rs.weekdays, ',')))
$$;

/* 학부모 신청 */
create or replace function public.submit_ride_request(
  p_student uuid, p_kind text, p_scope text, p_date date,
  p_from uuid, p_to uuid, p_action text, p_weekdays text, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_run uuid; v_cut int; v_dep timestamptz; v_late boolean := false; v_id uuid; sname text;
begin
  if not (public.is_my_child(p_student) or public.is_staff()) then raise exception 'not allowed'; end if;
  select org_id, name into v_org, sname from public.students where id = p_student;
  if p_kind not in ('skip', 'add', 'change') or p_scope not in ('once', 'always') then return jsonb_build_object('error', 'bad_request'); end if;
  if p_kind in ('skip', 'change') and p_from is null then return jsonb_build_object('error', 'bad_request'); end if;
  if p_kind in ('add', 'change') and p_to is null then return jsonb_build_object('error', 'bad_request'); end if;
  if p_scope = 'once' and p_date is null then return jsonb_build_object('error', 'bad_request'); end if;

  -- 마감: 하루 신청은 출발 cutoff 분 전까지. 지나면 사유 필수, 출발 뒤엔 신청 불가
  if p_scope = 'once' and not public.is_staff() then   -- 관리자·선생님은 마감 시간 상관없이 입력 가능
    select rs.run_id into v_run from public.run_stops rs where rs.id = coalesce(p_from, p_to);
    select cutoff_minutes into v_cut from public.runs where id = v_run;
    v_dep := public.run_departure(v_run, p_date);
    if v_dep is not null and now() > v_dep then return jsonb_build_object('error', 'departed'); end if;
    if v_dep is not null and now() > v_dep - make_interval(mins => coalesce(v_cut, 60)) then
      v_late := true;
      if coalesce(trim(p_reason), '') = '' then return jsonb_build_object('error', 'reason_required'); end if;
    end if;
  end if;

  insert into public.ride_requests (org_id, student_id, kind, scope, date, from_run_stop_id, to_run_stop_id, action, weekdays, reason, late)
  values (v_org, p_student, p_kind, p_scope, case when p_scope = 'once' then p_date end, p_from, p_to,
          coalesce(nullif(p_action, ''), 'board'), nullif(p_weekdays, ''), coalesce(p_reason, ''), v_late)
  returning id into v_id;

  insert into public.timeline (org_id, kind, summary, student_id, actor)
  values (v_org, 'shuttle', '📮 ' || sname || ' 차량 ' ||
    case p_kind when 'skip' then '안 탐' when 'add' then '탑승' else '장소 변경' end || ' 신청 (' ||
    case when p_scope = 'once' then to_char(p_date, 'FMMM/FMDD') else '계속' end || ')' ||
    case when v_late then ' · 마감 후' else '' end ||
    case when coalesce(p_reason, '') <> '' then ' · ' || p_reason else '' end, p_student, auth.uid());
  return jsonb_build_object('ok', true, 'id', v_id, 'late', v_late);
end $$;
grant execute on function public.submit_ride_request(uuid, text, text, date, uuid, uuid, text, text, text) to authenticated;

/* 학부모: 아직 처리 안 된 내 신청 취소 */
create or replace function public.cancel_ride_request(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.ride_requests set status = 'canceled'
   where id = p_id and status = 'pending' and (public.is_my_child(student_id) or public.is_staff());
end $$;
grant execute on function public.cancel_ride_request(uuid) to authenticated;

/* 관리자: 승인(차량표에 반영) / 거절 */
create or replace function public.decide_ride_request(p_id uuid, p_ok boolean, p_note text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare q record; old record; sname text; fname text; tname text; v_wd text;
begin
  if not public.is_staff() then raise exception 'not allowed'; end if;
  select * into q from public.ride_requests where id = p_id and org_id = public.my_org();
  if q.id is null then return jsonb_build_object('error', 'not_found'); end if;
  if q.status <> 'pending' then return jsonb_build_object('error', 'already'); end if;
  select name into sname from public.students where id = q.student_id;
  select s.name into fname from public.run_stops rs join public.stops s on s.id = rs.stop_id where rs.id = q.from_run_stop_id;
  select s.name into tname from public.run_stops rs join public.stops s on s.id = rs.stop_id where rs.id = q.to_run_stop_id;

  if not p_ok then
    update public.ride_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decide_note = coalesce(p_note, '') where id = p_id;
    insert into public.timeline (org_id, kind, summary, student_id, actor)
    values (q.org_id, 'shuttle', '❌ ' || sname || ' 차량 변경 신청 거절' || coalesce(' · ' || nullif(p_note, ''), ''), q.student_id, auth.uid());
    return jsonb_build_object('ok', true);
  end if;

  if q.scope = 'once' then
    if q.kind in ('skip', 'change') then
      insert into public.ride_exceptions (org_id, date, run_stop_id, student_id, action, type, request_id, note)
      select q.org_id, q.date, q.from_run_stop_id, q.student_id, a.action, 'skip', q.id, q.reason
        from public.ride_assignments a where a.run_stop_id = q.from_run_stop_id and a.student_id = q.student_id
      on conflict do nothing;
      if not found then
        insert into public.ride_exceptions (org_id, date, run_stop_id, student_id, action, type, request_id, note)
        values (q.org_id, q.date, q.from_run_stop_id, q.student_id, q.action, 'skip', q.id, q.reason) on conflict do nothing;
      end if;
    end if;
    if q.kind in ('add', 'change') then
      insert into public.ride_exceptions (org_id, date, run_stop_id, student_id, action, type, request_id, note)
      values (q.org_id, q.date, q.to_run_stop_id, q.student_id, q.action, 'add', q.id, q.reason) on conflict do nothing;
    end if;
  else
    -- 계속: 차량표(ride_assignments) 자체를 바꿈
    select * into old from public.ride_assignments where run_stop_id = q.from_run_stop_id and student_id = q.student_id limit 1;
    v_wd := coalesce(q.weekdays, old.weekdays);
    if q.kind in ('skip', 'change') then
      delete from public.ride_assignments where run_stop_id = q.from_run_stop_id and student_id = q.student_id;
    end if;
    if q.kind in ('add', 'change') then
      insert into public.ride_assignments (run_stop_id, student_id, action, weekdays, note)
      values (q.to_run_stop_id, q.student_id, coalesce(old.action, q.action), v_wd, '학부모 신청으로 변경')
      on conflict (run_stop_id, student_id, action) do update set weekdays = excluded.weekdays;
    end if;
  end if;

  update public.ride_requests set status = 'approved', decided_by = auth.uid(), decided_at = now(), decide_note = coalesce(p_note, '') where id = p_id;
  insert into public.timeline (org_id, kind, summary, student_id, actor)
  values (q.org_id, 'shuttle', '✅ ' || sname || ' 차량 ' ||
    case q.kind when 'skip' then '안 탐' when 'add' then '탑승' else '장소 변경' end || ' 승인 (' ||
    case when q.scope = 'once' then to_char(q.date, 'FMMM/FMDD') else '계속' end || ') ' ||
    coalesce(fname, '') || case when q.kind = 'change' then ' → ' else '' end || coalesce(tname, ''), q.student_id, auth.uid());
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.decide_ride_request(uuid, boolean, text) to authenticated;

do $$
declare t text;
begin
  foreach t in array array['ride_requests', 'ride_exceptions'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
notify pgrst, 'reload schema';
