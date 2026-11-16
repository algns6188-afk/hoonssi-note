-- 강철노트 v6: 수련생 상세 정보 + 보호자 연락처
-- schema-v5-assistant.sql 다음에 실행. 여러 번 실행해도 안전합니다.
-- (주민등록번호는 저장하지 않습니다)

alter table public.students add column if not exists student_no text not null default '';      -- 원래 학생번호
alter table public.students add column if not exists birth date;
alter table public.students add column if not exists gender text not null default '';          -- 남 / 여
alter table public.students add column if not exists phone text not null default '';           -- 학생 휴대폰
alter table public.students add column if not exists address text not null default '';
alter table public.students add column if not exists school text not null default '';
alter table public.students add column if not exists grade text not null default '';           -- 초4, 중1 …
alter table public.students add column if not exists class_name text not null default '';      -- 반 (입시반·선수단 …)
alter table public.students add column if not exists session_no int;                            -- 수업 시간대 1~6부
alter table public.students add column if not exists session_label text not null default '';   -- 2부 15:30~16:30
alter table public.students add column if not exists temp_class text not null default '';      -- 임시 반 (예: 국기원)
alter table public.students add column if not exists instructor text not null default '';
alter table public.students add column if not exists notes text not null default '';           -- 특이사항
alter table public.students add column if not exists attend_days text not null default '월,화,수,목,금';
alter table public.students add column if not exists joined_on date;
alter table public.students add column if not exists left_on date;
alter table public.students add column if not exists pay_day int;
alter table public.students add column if not exists cash_receipt boolean not null default true;
alter table public.students add column if not exists belt_poom int;                              -- 품·단
alter table public.students add column if not exists belt_level int;                             -- 급
alter table public.students add column if not exists belt_date date;
alter table public.students add column if not exists shuttle_use boolean not null default false;
alter table public.students add column if not exists shuttle_note text not null default '';     -- 차량 코스 메모
alter table public.students add column if not exists siblings_note text not null default '';

-- 보호자 연락처 (앱 가입과 별개. 가입한 학부모는 guardians 로 연결)
create table if not exists public.student_contacts (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students on delete cascade,
  name text not null default '',
  phone text not null default '',
  relation text not null default '',
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists student_contacts_student_idx on public.student_contacts (student_id);
alter table public.student_contacts enable row level security;
grant select, insert, update, delete on public.student_contacts to authenticated, service_role;
drop policy if exists contact_staff on public.student_contacts;
create policy contact_staff on public.student_contacts for all to authenticated
  using (public.is_staff() and exists (select 1 from public.students s where s.id = student_id and s.org_id = public.my_org()))
  with check (public.is_staff() and exists (select 1 from public.students s where s.id = student_id and s.org_id = public.my_org()));
drop policy if exists contact_parent on public.student_contacts;
create policy contact_parent on public.student_contacts for select to authenticated using (public.is_my_child(student_id));
