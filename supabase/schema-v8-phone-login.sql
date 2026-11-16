-- 강철노트 v8: 학부모 "전화번호 + 자녀 출석번호" 로그인
-- schema-v7-shuttle.sql 다음에 실행. 여러 번 실행해도 안전합니다.
-- 원생 명단의 보호자 연락처(student_contacts)에 있는 전화번호 + 그 집 아이의 출석번호가 맞으면
-- 학부모 계정을 만들거나(처음) 다시 열어 주고, 그 번호가 등록된 아이들을 모두 연결합니다.

create schema if not exists private;
create table if not exists private.phone_login_attempts (
  phone text not null,
  ok boolean not null,
  at timestamptz not null default now()
);
create index if not exists phone_login_attempts_idx on private.phone_login_attempts (phone, at);

create or replace function public.phone_digits(p text) returns text
language sql immutable as $$ select regexp_replace(coalesce(p, ''), '\D', '', 'g') $$;

create or replace function public.phone_login_prepare(p_phone text, p_code text)
returns jsonb
language plpgsql security definer set search_path = public, extensions, auth as $$
declare
  v_phone text := public.phone_digits(p_phone);
  v_code text := trim(coalesce(p_code, ''));
  v_fail int;
  v_kid record;
  v_org uuid;
  v_email text;
  v_pw text;
  v_uid uuid;
  v_name text;
  v_new boolean := false;
begin
  if length(v_phone) < 9 then return jsonb_build_object('error', 'bad_phone'); end if;

  -- 30분 안에 10번 넘게 틀리면 잠금
  select count(*) into v_fail from private.phone_login_attempts
   where phone = v_phone and not ok and at > now() - interval '30 minutes';
  if v_fail >= 10 then return jsonb_build_object('error', 'locked'); end if;

  -- 이 전화번호가 보호자로 등록된 아이 중 출석번호가 맞는 아이
  select s.id, s.org_id, c.name as cname, c.relation into v_kid
    from public.student_contacts c join public.students s on s.id = c.student_id
   where public.phone_digits(c.phone) = v_phone and s.active and s.code = v_code
   limit 1;
  if v_kid.id is null then
    -- 오류로 끝내면 기록까지 취소되므로, 기록을 남기고 결과로 알려줌
    insert into private.phone_login_attempts (phone, ok) values (v_phone, false);
    return jsonb_build_object('error', 'no_match');
  end if;
  v_org := v_kid.org_id;
  v_email := 'p' || v_phone || '@parent.kangcheol.invalid';
  v_pw := encode(gen_random_bytes(24), 'base64');   -- 이번 로그인에만 쓰는 비밀번호
  v_name := trim(coalesce(nullif(v_kid.cname, ''), '보호자') || case when coalesce(v_kid.relation, '') <> '' then ' (' || v_kid.relation || ')' else '' end);

  select id into v_uid from auth.users where email = v_email;
  if v_uid is null then
    v_uid := gen_random_uuid();
    v_new := true;
    insert into auth.users (
      id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change,
      email_change_token_current, phone_change, phone_change_token, reauthentication_token
    ) values (
      v_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_email,
      crypt(v_pw, gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('login', 'phone'), now(), now(),
      '', '', '', '', '', '', '', ''
    );
    insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_uid::text, v_uid,
      jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true),
      'email', now(), now(), now());
  else
    update auth.users set encrypted_password = crypt(v_pw, gen_salt('bf')), updated_at = now() where id = v_uid;
  end if;

  insert into public.members (user_id, org_id, role, display_name, lang)
  values (v_uid, v_org, 'parent', v_name, 'ko')
  on conflict (user_id) do nothing;

  -- 이 번호가 보호자로 등록된 아이들(형제 포함) 모두 연결
  insert into public.guardians (student_id, user_id)
  select distinct s.id, v_uid
    from public.student_contacts c join public.students s on s.id = c.student_id
   where public.phone_digits(c.phone) = v_phone and s.org_id = v_org
  on conflict do nothing;

  insert into private.phone_login_attempts (phone, ok) values (v_phone, true);
  delete from private.phone_login_attempts where at < now() - interval '1 day';

  if v_new then
    insert into public.timeline (org_id, kind, summary, actor)
    values (v_org, 'member', v_name || ' 님이 보호자 전화번호로 처음 로그인 (학부모)', v_uid);
  end if;

  return jsonb_build_object('email', v_email, 'password', v_pw);
end $$;

revoke all on function public.phone_login_prepare(text, text) from public;
grant execute on function public.phone_login_prepare(text, text) to anon, authenticated;
