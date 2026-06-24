-- Иконка категории каталога: slug из клиентской палитры (web icons.tsx). Чистая
-- косметика, пустое значение - дефолтная иконка. Таксономия категорий - в БД.
ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT '';
