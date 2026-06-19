DROP INDEX IF EXISTS uniq_active_namespace_identity;
ALTER TABLE requests DROP COLUMN IF EXISTS resource_identity;
