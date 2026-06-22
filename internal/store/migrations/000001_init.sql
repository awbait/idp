CREATE TABLE IF NOT EXISTS requests (
  id              UUID PRIMARY KEY,
  created_by      TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  team            TEXT NOT NULL,
  chart_project   TEXT NOT NULL,
  chart_name      TEXT NOT NULL,
  chart_version   TEXT NOT NULL,
  service_name    TEXT NOT NULL,
  cluster         TEXT NOT NULL DEFAULT 'in-cluster',
  values_yaml     TEXT NOT NULL,                 -- snapshot of values.yaml; Git is source of truth
  status          TEXT NOT NULL,
  argocd_app_name TEXT,                           -- computed once at creation
  version         INT NOT NULL DEFAULT 1,         -- optimistic lock
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

-- Uniqueness only among active orders; key mirrors the GitOps path
-- team-subgroup / chart / service_name.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_service
  ON requests (team, chart_name, service_name, cluster)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_requests_team ON requests(team);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_created_by ON requests(created_by);

CREATE TABLE IF NOT EXISTS request_mrs (
  id                UUID PRIMARY KEY,
  request_id        UUID NOT NULL REFERENCES requests(id),
  gitlab_project_id INT NOT NULL,
  mr_iid            INT NOT NULL,
  mr_url            TEXT NOT NULL,
  mr_status         TEXT NOT NULL,
  action            TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_request_mrs_request ON request_mrs(request_id);

CREATE TABLE IF NOT EXISTS request_events (
  id          BIGSERIAL PRIMARY KEY,
  request_id  UUID NOT NULL REFERENCES requests(id),
  actor       TEXT,
  event_type  TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_request_events_request ON request_events(request_id);
CREATE INDEX IF NOT EXISTS idx_request_events_created ON request_events(created_at);
