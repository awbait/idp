-- Несогласованная смена метаданных публикации: предложенные категория/владелец
-- живут в draft-колонках и применяются в category_id/owner_team только на approve
-- (как view_json → approved_view_json). Пустая строка — нет ожидающих изменений.
ALTER TABLE chart_publications
  ADD COLUMN IF NOT EXISTS draft_category_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS draft_owner_team  TEXT NOT NULL DEFAULT '';
