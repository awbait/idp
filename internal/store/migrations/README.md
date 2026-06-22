# Database migrations

Versioned SQL migrations managed by [Atlas](https://atlasgo.io). The portal
applies these files **in-process at startup** (`internal/store/migrate.go`); the
Atlas CLI is a dev/CI tool only and is not shipped in the runtime image.

## Layout

- `NNNNNN_name.sql` - one up-only migration per file, applied in lexicographic
  order. New files authored via `atlas migrate diff` use a timestamp version
  (e.g. `20260622120000_name.sql`); both formats sort and apply correctly.
- `atlas.sum` - integrity checksum. The runner verifies it on every startup
  (`migrate.Validate`), so a hand-edited `.sql` without a rehash fails fast.

There are no `.down.sql` files: the in-process runner is up-only, and Atlas
reverts by re-planning (`atlas migrate down`), not by reading down files.

Applied versions are tracked in the `schema_migrations` table (the project's own
ledger, not Atlas's `atlas_schema_revisions`). Do not run `atlas migrate apply`
against a real database - the app is the only applier.

## Authoring a migration

All commands need the Atlas CLI and Docker (for the ephemeral dev database) and
read `../../../atlas.hcl`:

```sh
# Hand-write NNNNNN_name.sql, then rehash:
atlas migrate hash --env local

# ...or generate from a schema diff:
atlas migrate diff <name> --env local

# Verify integrity and lint for destructive changes (also run in CI / pre-push):
atlas migrate validate --env local
atlas migrate lint --env local --git-base origin/main
```

After any manual edit you **must** run `atlas migrate hash`, or both the CI gate
and the runtime `migrate.Validate` check will reject the directory.
