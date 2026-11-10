-- 훈씨노트 팀 공유 서버 설정
-- Supabase 대시보드 → SQL Editor 에 전체를 붙여넣고 Run 을 누르세요.
-- 여러 번 실행해도 안전합니다.

create or replace function public.hoonssi_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- 다른 PC가 더 나중에 고친 내용이 이미 있으면, 늦게 도착한 옛 변경은 무시
  if tg_op = 'UPDATE' and new.changed_at < old.changed_at then
    return null;
  end if;
  new.updated_at := clock_timestamp();
  new.updated_by := auth.uid();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['notes', 'tasks', 'athletes', 'growth_records'] loop
    execute format('create table if not exists public.%I (
      id text primary key,
      data jsonb,
      changed_at text not null,
      deleted boolean not null default false,
      updated_at timestamptz not null default clock_timestamp(),
      updated_by uuid
    )', t);
    execute format('create index if not exists %I on public.%I (updated_at)', t || '_updated_at_idx', t);

    execute format('drop trigger if exists hoonssi_touch on public.%I', t);
    execute format('create trigger hoonssi_touch before insert or update on public.%I
      for each row execute function public.hoonssi_touch()', t);

    -- 로그인한 팀원만 읽고 쓸 수 있음 (삭제는 '삭제 표시'로 처리)
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists team_select on public.%I', t);
    execute format('drop policy if exists team_insert on public.%I', t);
    execute format('drop policy if exists team_update on public.%I', t);
    execute format('create policy team_select on public.%I for select to authenticated using (true)', t);
    execute format('create policy team_insert on public.%I for insert to authenticated with check (true)', t);
    execute format('create policy team_update on public.%I for update to authenticated using (true) with check (true)', t);

    -- 실시간 반영
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
