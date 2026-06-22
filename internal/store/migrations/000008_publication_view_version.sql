-- Версия чарта, под которую согласован активный view (latest на момент approve).
-- «Благословлённая» версия: по ней проверен view; до неё можно обновлять заказы,
-- новее в Harbor — сигнал автору обновить view.
ALTER TABLE chart_publications
  ADD COLUMN IF NOT EXISTS approved_view_version TEXT NOT NULL DEFAULT '';
