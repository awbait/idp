-- Per-instance target namespace for the ArgoCD Application destination.
-- Empty string means "fall back to service_name" (preserves prior behaviour).
ALTER TABLE requests ADD COLUMN IF NOT EXISTS namespace TEXT NOT NULL DEFAULT '';
