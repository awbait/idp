-- Drift detection: flag orders whose committed Git state (values.yaml / chart
-- version) was changed outside the portal. Read-only signal set by the poller.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS drifted boolean NOT NULL DEFAULT false;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS drift_detail text NOT NULL DEFAULT '';
