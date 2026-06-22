# Atlas configuration (https://atlasgo.io).
#
# The migration directory internal/store/migrations is OWNED by Atlas tooling:
# authoring, atlas.sum integrity, and the `atlas migrate lint` CI gate. The
# portal applies the very same files in-process at startup (internal/store/
# migrate.go), so the Atlas CLI is a dev/CI tool only - it is NOT shipped in the
# runtime image, and migrations are NOT applied with `atlas migrate apply` in
# production (the app is the only applier; it tracks state in schema_migrations,
# not Atlas's atlas_schema_revisions - do not mix the two on one database).
#
# Install the CLI (dev only): https://atlasgo.io/getting-started
#   scoop install atlas      # Windows
#   curl -sSf https://atlasgo.sh | sh   # Linux/macOS
#
# Common commands (all need Docker for the ephemeral dev database):
#   atlas migrate diff <name> --env local   # author a migration from a schema diff
#   atlas migrate hash        --env local   # rehash atlas.sum after a manual edit
#   atlas migrate lint        --env local --git-base origin/main   # CI/pre-push gate
#   atlas migrate validate    --env local   # verify atlas.sum matches the files

env "local" {
  # Versioned migration directory, shared with the in-process runner.
  migration {
    dir = "file://internal/store/migrations"
  }

  # Ephemeral scratch database Atlas spins up (and tears down) to plan diffs and
  # replay migrations for lint/validate. Pinned to the deployed Postgres major
  # (postgres:16-alpine in deployments/docker-compose.yml). Requires Docker.
  dev = "docker://postgres/16/dev?search_path=public"
}
