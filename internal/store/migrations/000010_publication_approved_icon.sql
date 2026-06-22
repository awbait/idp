-- Снапшот иконки чарта на момент согласования (как approved_description): каталог
-- и профиль чарта показывают согласованную иконку, а не живую из Harbor.
ALTER TABLE chart_publications
  ADD COLUMN IF NOT EXISTS approved_icon_url TEXT NOT NULL DEFAULT '';
