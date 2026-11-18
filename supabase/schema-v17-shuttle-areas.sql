-- 강철노트 v17: 운행 구역 표시 (갈 수 있는/못 가는 길·동네를 지도에 직접 그림)
-- schema-v16-absence-kinds.sql 다음에 실행. 여러 번 실행해도 안전합니다.

create table if not exists public.shuttle_areas (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs on delete cascade,
  name text not null default '',
  kind text not null check (kind in ('ok', 'no')),          -- 갈 수 있음 / 못 감
  shape text not null check (shape in ('line', 'area')),    -- 길(선) / 동네(영역)
  points jsonb not null,                                    -- [[위도, 경도], ...]
  show_parents boolean not null default true,               -- 학부모 지도에도 보이기
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists shuttle_areas_org_idx on public.shuttle_areas (org_id);

alter table public.shuttle_areas enable row level security;
grant select, insert, update, delete on public.shuttle_areas to authenticated, service_role;
drop policy if exists area_staff on public.shuttle_areas;
create policy area_staff on public.shuttle_areas for all to authenticated
  using (org_id = public.my_org() and public.is_staff()) with check (org_id = public.my_org() and public.is_staff());
drop policy if exists area_parent on public.shuttle_areas;
create policy area_parent on public.shuttle_areas for select to authenticated
  using (org_id = public.my_org() and show_parents);
notify pgrst, 'reload schema';
