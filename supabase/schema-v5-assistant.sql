-- 강철노트 v5: 결석 기록 + 관리자 자동 입력(AI) 기록
-- schema-v4-billing.sql 다음에 실행. 여러 번 실행해도 안전합니다.

create table if not exists public.absences (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  student_id uuid not null references public.students on delete cascade,
  date date not null,
  reason text not null default '',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (student_id, date)
);
create index if not exists absences_org_date_idx on public.absences (org_id, date);

alter table public.absences enable row level security;
grant select, insert, update, delete on public.absences to authenticated, service_role;

drop policy if exists absence_staff on public.absences;
create policy absence_staff on public.absences for all to authenticated
  using (org_id = public.my_org() and public.is_staff()) with check (org_id = public.my_org() and public.is_staff());
-- 학부모: 우리 아이 결석은 보고, 직접 알릴 수도 있음
drop policy if exists absence_parent_read on public.absences;
create policy absence_parent_read on public.absences for select to authenticated using (public.is_my_child(student_id));
drop policy if exists absence_parent_insert on public.absences;
create policy absence_parent_insert on public.absences for insert to authenticated
  with check (org_id = public.my_org() and public.is_my_child(student_id));

create or replace function public.absences_timeline() returns trigger
language plpgsql security definer set search_path = public as $$
declare sname text; who text;
begin
  select name into sname from public.students where id = new.student_id;
  select display_name || case role when 'parent' then ' (학부모)' else '' end into who from public.members where user_id = new.created_by;
  insert into public.timeline (org_id, kind, summary, student_id, ref_table, ref_id, actor)
  values (new.org_id, 'absence',
    sname || ' ' || to_char(new.date, 'FMMM/FMDD') || ' 결석' || case when new.reason <> '' then ' · ' || new.reason else '' end
      || coalesce(' — ' || nullif(who, ''), ''),
    new.student_id, 'absences', new.id, new.created_by);
  return new;
end $$;
drop trigger if exists absences_timeline on public.absences;
create trigger absences_timeline after insert on public.absences
  for each row execute function public.absences_timeline();

do $$
begin
  begin
    execute 'alter publication supabase_realtime add table public.absences';
  exception when duplicate_object then null;
  end;
end $$;
