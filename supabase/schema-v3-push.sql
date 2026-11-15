-- 강철노트 v3: 출석 앱 알림 (웹 푸시)
-- schema-v2.sql 다음에 실행. 여러 번 실행해도 안전합니다.
-- 알림 서버 주소·비밀값은 이 파일에 넣지 않고 private.config 표에 따로 저장합니다.

create extension if not exists pg_net with schema extensions;

/* ---------------- 알림 받을 기기 ---------------- */

create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users on delete cascade,
  p256dh text not null,
  auth text not null,
  lang text not null default 'ko',
  user_agent text not null default '',
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
drop policy if exists push_own on public.push_subscriptions;
create policy push_own on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 관리자 화면: 이 학생 보호자들이 알림을 켰는지 (기기 주소는 보여주지 않음)
create or replace function public.guardian_push_status(p_student uuid)
returns table (user_id uuid, devices int)
language sql stable security definer set search_path = public as $$
  select g.user_id, (select count(*)::int from public.push_subscriptions p where p.user_id = g.user_id)
  from public.guardians g
  join public.students s on s.id = g.student_id
  where g.student_id = p_student and s.org_id = public.my_org() and public.is_staff()
$$;
grant execute on function public.guardian_push_status(uuid) to authenticated;

/* ---------------- 출석이 기록되면 알림 서버 호출 ---------------- */

create schema if not exists private;
revoke all on schema private from public;
create table if not exists private.config (key text primary key, value text not null);

create or replace function public.notify_attendance() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare v_url text; v_secret text;
begin
  select value into v_url from private.config where key = 'notify_url';
  select value into v_secret from private.config where key = 'notify_secret';
  if v_url is null then return new; end if;
  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('attendance_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-notify-secret', v_secret),
    timeout_milliseconds := 10000
  );
  return new;
end $$;

drop trigger if exists notify_attendance on public.attendance;
create trigger notify_attendance after insert on public.attendance
  for each row execute function public.notify_attendance();

/* ---------------- 서버 기능(알림 발송 등)이 쓰는 관리자 역할 권한 ----------------
   프로젝트를 만들 때 "새 표 자동 공개"를 껐기 때문에 직접 권한을 줌 */
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
