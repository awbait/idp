-- Снапшот описания чарта на момент approve: каталог показывает согласованное
-- описание, а не живое из Harbor (обновляется только после нового согласования).
ALTER TABLE chart_publications
  ADD COLUMN IF NOT EXISTS approved_description TEXT NOT NULL DEFAULT '';
