-- 강철노트 v16: 출결 상태 추가 — 결석 · 병가 · 체험학습 · 조퇴
-- schema-v15-stop-parent-name.sql 다음에 실행. 여러 번 실행해도 안전합니다.
-- 결석 기록(absences)에 종류를 붙임. 조퇴는 "왔다가 일찍 감" (등원 기록 + 조퇴 표시)

alter table public.absences add column if not exists kind text not null default 'absent';
do $$
begin
  alter table public.absences add constraint absences_kind_check check (kind in ('absent', 'sick', 'trip', 'early'));
exception when duplicate_object then null;
end $$;

create or replace function public.absence_label(k text) returns text
language sql immutable as $$
  select case k when 'sick' then '병가' when 'trip' then '체험학습' when 'early' then '조퇴' else '결석' end
$$;

create or replace function public.absences_timeline() returns trigger
language plpgsql security definer set search_path = public as $$
declare sname text; who text;
begin
  select name into sname from public.students where id = new.student_id;
  select display_name || case role when 'parent' then ' (학부모)' else '' end into who from public.members where user_id = new.created_by;
  insert into public.timeline (org_id, kind, summary, student_id, ref_table, ref_id, actor)
  values (new.org_id, 'absence',
    sname || ' ' || to_char(new.date, 'FMMM/FMDD') || ' ' || public.absence_label(new.kind) || case when new.reason <> '' then ' · ' || new.reason else '' end
      || coalesce(' — ' || nullif(who, ''), ''),
    new.student_id, 'absences', new.id, new.created_by);
  return new;
end $$;
notify pgrst, 'reload schema';
