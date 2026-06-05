-- Категории каталога: группировка опубликованных чартов в каталоге и левом меню.
CREATE TABLE IF NOT EXISTS categories (
  id    TEXT PRIMARY KEY,            -- slug (databases, network, ...)
  label TEXT NOT NULL,
  sort  INT NOT NULL DEFAULT 0
);

-- Публикация чарта: портальные метаданные поверх живого Harbor-листинга
-- (категория, владелец) + view-документ (бывший web/public/schemas/<chart>.ui.json).
-- status отражает жизненный цикл черновика view; согласованная версия живёт в
-- approved_view_json и продолжает работать, пока новый черновик на ревью.
CREATE TABLE IF NOT EXISTS chart_publications (
  id                 UUID PRIMARY KEY,
  chart_project      TEXT NOT NULL,
  chart_name         TEXT NOT NULL,
  category_id        TEXT NOT NULL REFERENCES categories(id),
  owner_team         TEXT NOT NULL,                -- группа-владелец (управление)
  created_by         TEXT NOT NULL,                -- автор (кто добавил)
  created_by_name    TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL,                -- DRAFT | PENDING | APPROVED | REJECTED
  view_json          JSONB,                        -- черновик view-документа
  approved_view_json JSONB,                        -- активная согласованная версия
  reviewed_by        TEXT NOT NULL DEFAULT '',
  review_comment     TEXT NOT NULL DEFAULT '',
  version            INT NOT NULL DEFAULT 1,       -- optimistic lock
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_publication_chart
  ON chart_publications (chart_project, chart_name);
CREATE INDEX IF NOT EXISTS idx_publications_status ON chart_publications(status);
CREATE INDEX IF NOT EXISTS idx_publications_team ON chart_publications(owner_team);

-- Аудит публикаций (по образцу request_events).
CREATE TABLE IF NOT EXISTS publication_events (
  id             BIGSERIAL PRIMARY KEY,
  publication_id UUID NOT NULL REFERENCES chart_publications(id),
  actor          TEXT,
  event_type     TEXT NOT NULL,
  from_status    TEXT,
  to_status      TEXT,
  payload        JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_publication_events_pub ON publication_events(publication_id);
