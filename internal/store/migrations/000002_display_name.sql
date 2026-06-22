-- Cosmetic, user-facing instance name. Distinct from service_name (the immutable
-- deploy identity). Mutable, no deploy impact. Defaults to '' (UI falls back to
-- service_name when empty).
ALTER TABLE requests ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';
