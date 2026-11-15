-- 강철노트 v2: 도장(조직) · 역할(관리자/선생님/학부모/출석태블릿) · 학생 · 출석 · 타임라인
-- Supabase 대시보드 → SQL Editor 에 전체를 붙여넣고 Run 을 누르세요.
-- schema.sql(1단계)을 먼저 실행한 상태여야 하며, 여러 번 실행해도 안전합니다.

create extension if not exists pgcrypto;

/* ---------------- 표 ---------------- */

create table if not exists public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- 로그인한 사람이 어느 도장의 누구인지
create table if not exists public.members (
  user_id uuid primary key references auth.users on delete cascade,
  org_id uuid not null references public.orgs on delete cascade,
  role text not null check (role in ('admin', 'staff', 'parent', 'kiosk')),
  display_name text not null default '',
  lang text not null default 'ko',
  created_at timestamptz not null default now()
);

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  name text not null,
  code text not null,                       -- 출석 번호
  group_name text not null default '',      -- 일반부 / 입시부 …
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, code)
);

-- 학부모 ↔ 학생 연결 (형제는 여러 줄)
create table if not exists public.guardians (
  student_id uuid not null references public.students on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  primary key (student_id, user_id)
);

-- 초대 코드 (학부모·선생님·출석태블릿 가입용)
create table if not exists public.invites (
  code text primary key,
  org_id uuid not null references public.orgs on delete cascade,
  role text not null check (role in ('staff', 'parent', 'kiosk')),
  student_ids uuid[] not null default '{}',
  label text not null default '',
  max_uses int not null default 2,          -- 엄마·아빠 둘 다 쓸 수 있게 기본 2회
  use_count int not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  student_id uuid not null references public.students on delete cascade,
  kind text not null check (kind in ('in', 'out')),   -- 등원 / 하원
  at timestamptz not null default now(),
  source text not null default 'staff' check (source in ('kiosk', 'staff')),
  created_by uuid default auth.uid()
);
create index if not exists attendance_student_at_idx on public.attendance (student_id, at desc);
create index if not exists attendance_org_at_idx on public.attendance (org_id, at desc);

-- 무엇이 어디에 반영됐는지 기록 (관리자 타임라인)
create table if not exists public.timeline (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  kind text not null,
  summary text not null,
  student_id uuid references public.students on delete set null,
  ref_table text,
  ref_id uuid,
  actor uuid default auth.uid(),
  at timestamptz not null default now()
);
create index if not exists timeline_org_at_idx on public.timeline (org_id, at desc);

/* ---------------- 처음 한 번: 도장 만들고 기존 계정을 관리자로 ---------------- */

do $$
declare oid uuid;
begin
  if not exists (select 1 from public.members) then
    select id into oid from public.orgs limit 1;
    if oid is null then
      insert into public.orgs (name) values ('강철 태권도장') returning id into oid;
    end if;
    insert into public.members (user_id, org_id, role, display_name)
      select u.id, oid, 'admin', coalesce(split_part(u.email, '@', 1), '')
      from auth.users u;
  end if;
end $$;

/* ---------------- 권한 확인용 함수 ---------------- */

create or replace function public.my_org() returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from public.members where user_id = auth.uid()
$$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.members where user_id = auth.uid()
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('admin', 'staff') from public.members where user_id = auth.uid()), false)
$$;

create or replace function public.is_my_child(sid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.guardians where student_id = sid and user_id = auth.uid())
$$;

/* ---------------- 기존 표(노트·할 일·선수 기록): 선생님·관리자만 ---------------- */

do $$
declare t text;
begin
  foreach t in array array['notes', 'tasks', 'athletes', 'growth_records'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists team_select on public.%I', t);
      execute format('drop policy if exists team_insert on public.%I', t);
      execute format('drop policy if exists team_update on public.%I', t);
      execute format('create policy team_select on public.%I for select to authenticated using (public.is_staff())', t);
      execute format('create policy team_insert on public.%I for insert to authenticated with check (public.is_staff())', t);
      execute format('create policy team_update on public.%I for update to authenticated using (public.is_staff()) with check (public.is_staff())', t);
    end if;
  end loop;
end $$;

/* ---------------- 새 표 권한 ---------------- */

alter table public.orgs enable row level security;
alter table public.members enable row level security;
alter table public.students enable row level security;
alter table public.guardians enable row level security;
alter table public.invites enable row level security;
alter table public.attendance enable row level security;
alter table public.timeline enable row level security;

grant select, update on public.orgs to authenticated;
grant select, update on public.members to authenticated;
grant select, insert, update, delete on public.students, public.guardians, public.invites to authenticated;
grant select, insert, delete on public.attendance to authenticated;
grant select, insert on public.timeline to authenticated;

drop policy if exists org_read on public.orgs;
create policy org_read on public.orgs for select to authenticated using (id = public.my_org());
drop policy if exists org_admin on public.orgs;
create policy org_admin on public.orgs for update to authenticated
  using (id = public.my_org() and public.my_role() = 'admin');

-- 본인 정보는 누구나 보고(언어·이름) 고칠 수 있음, 역할은 못 바꿈 (아래 트리거)
drop policy if exists member_read on public.members;
create policy member_read on public.members for select to authenticated
  using (user_id = auth.uid() or (org_id = public.my_org() and public.is_staff()));
drop policy if exists member_update on public.members;
create policy member_update on public.members for update to authenticated
  using (user_id = auth.uid() or (org_id = public.my_org() and public.my_role() = 'admin'));

drop policy if exists student_read on public.students;
create policy student_read on public.students for select to authenticated
  using (org_id = public.my_org() and (public.is_staff() or public.is_my_child(id)));
drop policy if exists student_write on public.students;
create policy student_write on public.students for all to authenticated
  using (org_id = public.my_org() and public.is_staff())
  with check (org_id = public.my_org() and public.is_staff());

drop policy if exists guardian_read on public.guardians;
create policy guardian_read on public.guardians for select to authenticated
  using (user_id = auth.uid() or public.is_staff());
drop policy if exists guardian_write on public.guardians;
create policy guardian_write on public.guardians for all to authenticated
  using (public.is_staff() and exists (select 1 from public.students s where s.id = student_id and s.org_id = public.my_org()))
  with check (public.is_staff() and exists (select 1 from public.students s where s.id = student_id and s.org_id = public.my_org()));

drop policy if exists invite_staff on public.invites;
create policy invite_staff on public.invites for all to authenticated
  using (org_id = public.my_org() and public.is_staff())
  with check (org_id = public.my_org() and public.is_staff());

drop policy if exists attendance_read on public.attendance;
create policy attendance_read on public.attendance for select to authenticated
  using (org_id = public.my_org() and (public.is_staff() or public.is_my_child(student_id)));
drop policy if exists attendance_staff on public.attendance;
create policy attendance_staff on public.attendance for insert to authenticated
  with check (org_id = public.my_org() and public.is_staff());
drop policy if exists attendance_delete on public.attendance;
create policy attendance_delete on public.attendance for delete to authenticated
  using (org_id = public.my_org() and public.is_staff());

drop policy if exists timeline_staff on public.timeline;
create policy timeline_staff on public.timeline for select to authenticated
  using (org_id = public.my_org() and public.is_staff());
drop policy if exists timeline_insert on public.timeline;
create policy timeline_insert on public.timeline for insert to authenticated
  with check (org_id = public.my_org() and public.is_staff());

-- 관리자가 아니면 역할·도장을 스스로 바꿀 수 없음
create or replace function public.members_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.role <> old.role or new.org_id <> old.org_id) and coalesce(public.my_role(), '') <> 'admin' then
    raise exception '역할은 관리자만 바꿀 수 있습니다';
  end if;
  return new;
end $$;
drop trigger if exists members_guard on public.members;
create trigger members_guard before update on public.members for each row execute function public.members_guard();

/* ---------------- 출석이 기록되면 타임라인에 자동 기록 ---------------- */

create or replace function public.attendance_to_timeline() returns trigger
language plpgsql security definer set search_path = public as $$
declare sname text;
begin
  select name into sname from public.students where id = new.student_id;
  insert into public.timeline (org_id, kind, summary, student_id, ref_table, ref_id, actor, at)
  values (new.org_id, 'attendance',
          sname || ' ' || case new.kind when 'in' then '등원' else '하원' end ||
          case new.source when 'kiosk' then ' (출석 태블릿)' else ' (선생님 체크)' end,
          new.student_id, 'attendance', new.id, new.created_by, new.at);
  return new;
end $$;
drop trigger if exists attendance_to_timeline on public.attendance;
create trigger attendance_to_timeline after insert on public.attendance
  for each row execute function public.attendance_to_timeline();

/* ---------------- 출석 태블릿용 함수 (학생 명단을 통째로 보지 못하게) ---------------- */

-- 번호로 이름 확인 (+ 오늘 마지막 기록으로 등원/하원 추천)
create or replace function public.kiosk_lookup(p_code text)
returns table (student_id uuid, name text, suggested text, last_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare r text := public.my_role();
begin
  if r is null or r not in ('admin', 'staff', 'kiosk') then raise exception 'not allowed'; end if;
  return query
    select s.id, s.name,
      case when a.kind = 'in' then 'out' else 'in' end,
      a.at
    from public.students s
    left join lateral (
      select kind, at from public.attendance x
      where x.student_id = s.id and x.at >= date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul'
      order by at desc limit 1
    ) a on true
    where s.org_id = public.my_org() and s.code = trim(p_code) and s.active;
end $$;

-- 출석 기록 (1분 안에 같은 기록을 또 누르면 한 번만 저장)
create or replace function public.kiosk_check(p_code text, p_kind text)
returns table (student_id uuid, name text, kind text, at timestamptz, duplicate boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare r text := public.my_role(); s record; last record; v_at timestamptz;
begin
  if r is null or r not in ('admin', 'staff', 'kiosk') then raise exception 'not allowed'; end if;
  if p_kind not in ('in', 'out') then raise exception 'bad kind'; end if;
  select id, name into s from public.students
    where org_id = public.my_org() and code = trim(p_code) and active;
  if s.id is null then raise exception 'not found'; end if;
  select a.id, a.kind, a.at into last from public.attendance a
    where a.student_id = s.id order by a.at desc limit 1;
  if last.id is not null and last.kind = p_kind and last.at > now() - interval '1 minute' then
    return query select s.id, s.name, p_kind, last.at, true;
    return;
  end if;
  insert into public.attendance (org_id, student_id, kind, source)
    values (public.my_org(), s.id, p_kind, case when r = 'kiosk' then 'kiosk' else 'staff' end)
    returning attendance.at into v_at;
  return query select s.id, s.name, p_kind, v_at, false;
end $$;

/* ---------------- 초대 코드로 가입 연결 ---------------- */

create or replace function public.redeem_invite(p_code text, p_name text, p_lang text default 'ko')
returns text
language plpgsql security definer set search_path = public as $$
declare inv record; uid uuid := auth.uid();
begin
  if uid is null then raise exception '로그인이 필요합니다'; end if;
  select * into inv from public.invites where code = upper(trim(p_code)) for update;
  if inv.code is null then raise exception 'invalid_code'; end if;
  if inv.expires_at < now() then raise exception 'expired_code'; end if;
  if inv.use_count >= inv.max_uses then raise exception 'used_code'; end if;
  if exists (select 1 from public.members where user_id = uid and org_id <> inv.org_id) then
    raise exception 'other_org';
  end if;

  insert into public.members (user_id, org_id, role, display_name, lang)
    values (uid, inv.org_id, inv.role, coalesce(nullif(trim(p_name), ''), ''), coalesce(nullif(p_lang, ''), 'ko'))
    on conflict (user_id) do nothing;
  if inv.role = 'parent' then
    insert into public.guardians (student_id, user_id)
      select unnest(inv.student_ids), uid on conflict do nothing;
  end if;
  update public.invites set use_count = use_count + 1 where code = inv.code;
  insert into public.timeline (org_id, kind, summary, actor)
    values (inv.org_id, 'member',
      coalesce(nullif(trim(p_name), ''), '새 사용자') || ' 님이 초대 코드로 가입 (' ||
      case inv.role when 'parent' then '학부모' when 'staff' then '선생님' else '출석 태블릿' end ||
      case when inv.label <> '' then ' · ' || inv.label else '' end || ')', uid);
  return inv.role;
end $$;

-- 가입 전에 코드가 맞는지만 확인 (로그인 전에도 사용, 코드 내용은 알려주지 않음)
create or replace function public.check_invite(p_code text)
returns table (valid boolean, role text, reason text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare inv record;
begin
  select * into inv from public.invites where code = upper(trim(p_code));
  if inv.code is null then return query select false, null::text, 'invalid_code'; return; end if;
  if inv.expires_at < now() then return query select false, inv.role, 'expired_code'; return; end if;
  if inv.use_count >= inv.max_uses then return query select false, inv.role, 'used_code'; return; end if;
  return query select true, inv.role, null::text;
end $$;
grant execute on function public.check_invite(text) to anon, authenticated;

grant execute on function public.my_org(), public.my_role(), public.is_staff(), public.is_my_child(uuid),
  public.kiosk_lookup(text), public.kiosk_check(text, text), public.redeem_invite(text, text, text) to authenticated;

/* ---------------- 실시간 반영 ---------------- */

do $$
declare t text;
begin
  foreach t in array array['students', 'attendance', 'timeline', 'guardians'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
