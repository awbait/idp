-- Import/discovery: mark orders adopted from Git (their application.yaml was
-- created outside the portal and discovered by the import reconciler).
ALTER TABLE requests ADD COLUMN IF NOT EXISTS imported boolean NOT NULL DEFAULT false;
