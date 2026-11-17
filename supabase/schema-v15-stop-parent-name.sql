-- 강철노트 v15: 정류장 이름을 관리자용 / 학부모용으로 따로 (비워 두면 관리자 이름과 같음)
-- schema-v14-parent-trip-privacy.sql 다음에 실행. 여러 번 실행해도 안전합니다.
alter table public.stops add column if not exists parent_name text;
notify pgrst, 'reload schema';
