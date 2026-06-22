package store

import (
	"context"
	"embed"
	"fmt"
	"strconv"

	"ariga.io/atlas/sql/migrate"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql migrations/atlas.sum
var migrationsFS embed.FS

// migrationLockKey serializes migration runs across replicas via a Postgres
// session-level advisory lock. Arbitrary constant ("console" in ASCII); only
// this code uses it, so any other lock holder is another replica migrating.
const migrationLockKey int64 = 0x636f6e736f6c65

// Migrate applies all pending Atlas migration files in order. The directory is
// owned by Atlas tooling (authoring via `atlas migrate diff`, integrity via
// atlas.sum, CI gate via `atlas migrate lint`); this in-process runner only
// applies them at startup, keeping the deployment a single self-contained binary
// without the Atlas CLI in the runtime image.
//
// Applied versions are tracked in schema_migrations (one BIGINT per file,
// derived from the file's numeric version prefix). This is the project's own
// ledger, not Atlas's atlas_schema_revisions; do not mix this runner with
// `atlas migrate apply` against the same database.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	dir, err := loadMigrationDir()
	if err != nil {
		return err
	}
	// Fail fast if a migration file was edited without rehashing (atlas.sum out
	// of date). Mirrors `atlas migrate validate` and protects the embedded copy.
	if err := migrate.Validate(dir); err != nil {
		return fmt.Errorf("validate migrations: %w", err)
	}
	files, err := dir.Files()
	if err != nil {
		return err
	}

	// Hold the advisory lock and run every statement on one dedicated connection
	// so the lock spans the whole run (session-level locks are per-connection).
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, migrationLockKey); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	defer func() { _, _ = conn.Exec(ctx, `SELECT pg_advisory_unlock($1)`, migrationLockKey) }()

	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version BIGINT PRIMARY KEY)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	for _, f := range files {
		version, err := strconv.ParseInt(f.Version(), 10, 64)
		if err != nil {
			return fmt.Errorf("bad migration version %q: %w", f.Name(), err)
		}
		var exists bool
		if err := conn.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)`, version).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}
		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(f.Bytes())); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("apply %s: %w", f.Name(), err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations(version) VALUES($1)`, version); err != nil {
			_ = tx.Rollback(ctx)
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}

// loadMigrationDir copies the embedded migration files (and atlas.sum) into an
// in-memory Atlas directory so the SDK can parse versions and verify integrity.
func loadMigrationDir() (migrate.Dir, error) {
	dir := &migrate.MemDir{}
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		b, err := migrationsFS.ReadFile("migrations/" + e.Name())
		if err != nil {
			return nil, err
		}
		if err := dir.WriteFile(e.Name(), b); err != nil {
			return nil, err
		}
	}
	return dir, nil
}
