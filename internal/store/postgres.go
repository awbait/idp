package store

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"idp/pkg/models"
)

// Postgres is the production Store backed by pgx.
type Postgres struct {
	pool *pgxpool.Pool
}

var _ Store = (*Postgres)(nil)

// NewPostgres opens a pool, applies migrations, and returns the store.
func NewPostgres(ctx context.Context, url string, maxConns int32) (*Postgres, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	if maxConns > 0 {
		cfg.MaxConns = maxConns
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	if err := Migrate(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	return &Postgres{pool: pool}, nil
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// isInvalidUUID reports a Postgres invalid_text_representation error (22P02),
// raised when a malformed UUID is compared against a uuid column. A value that
// cannot be a valid id can never match a row, so we treat it as "not found".
func isInvalidUUID(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "22P02"
}

func (p *Postgres) CreateRequest(ctx context.Context, r *models.Request) error {
	if r.Version == 0 {
		r.Version = 1
	}
	_, err := p.pool.Exec(ctx, `
		INSERT INTO requests
		(id, created_by, created_by_name, team, chart_project, chart_name, chart_version,
		 service_name, display_name, cluster, namespace, values_yaml, status, argocd_app_name, version, imported)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
		r.ID, r.CreatedBy, r.CreatedByName, r.Team, r.ChartProject, r.ChartName, r.ChartVersion,
		r.ServiceName, r.DisplayName, r.Cluster, r.Namespace, r.ValuesYAML, r.Status, nullStr(r.ArgoCDAppName), r.Version, r.Imported)
	if isUniqueViolation(err) {
		return models.ErrConflict
	}
	return err
}

const reqCols = `id, created_by, created_by_name, team, chart_project, chart_name, chart_version,
	service_name, COALESCE(display_name,''), cluster, COALESCE(namespace,''), values_yaml, status, COALESCE(argocd_app_name,''), version,
	created_at, updated_at, deleted_at, COALESCE(drifted,false), COALESCE(drift_detail,''), COALESCE(imported,false)`

func scanRequest(row pgx.Row) (*models.Request, error) {
	var r models.Request
	err := row.Scan(&r.ID, &r.CreatedBy, &r.CreatedByName, &r.Team, &r.ChartProject, &r.ChartName,
		&r.ChartVersion, &r.ServiceName, &r.DisplayName, &r.Cluster, &r.Namespace, &r.ValuesYAML, &r.Status, &r.ArgoCDAppName,
		&r.Version, &r.CreatedAt, &r.UpdatedAt, &r.DeletedAt, &r.Drifted, &r.DriftDetail, &r.Imported)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidUUID(err) {
		return nil, models.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (p *Postgres) GetRequest(ctx context.Context, id string) (*models.Request, error) {
	return scanRequest(p.pool.QueryRow(ctx, `SELECT `+reqCols+` FROM requests WHERE id=$1`, id))
}

func (p *Postgres) ListRequests(ctx context.Context, f RequestFilter) ([]*models.Request, error) {
	q := `SELECT ` + reqCols + ` FROM requests WHERE 1=1`
	args := []any{}
	add := func(cond string, v any) { args = append(args, v); q += cond + "$" + itoa(len(args)) }

	if !f.IncludeDeleted {
		q += " AND deleted_at IS NULL"
	}
	if !f.Admin && len(f.Teams) > 0 {
		args = append(args, f.Teams)
		q += " AND team = ANY($" + itoa(len(args)) + ")"
	}
	if f.Team != "" {
		add(" AND team=", f.Team)
	}
	if f.Status != "" {
		add(" AND status=", string(f.Status))
	}
	if f.Chart != "" {
		add(" AND chart_name=", f.Chart)
	}
	q += " ORDER BY created_at DESC"

	rows, err := p.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.Request
	for rows.Next() {
		r, err := scanRequest(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (p *Postgres) UpdateRequest(ctx context.Context, r *models.Request) error {
	tag, err := p.pool.Exec(ctx, `
		UPDATE requests SET
		  chart_version=$1, values_yaml=$2, status=$3, argocd_app_name=$4, display_name=$5,
		  service_name=$6, cluster=$7, namespace=$8, deleted_at=$9, version=version+1, updated_at=NOW()
		WHERE id=$10 AND version=$11`,
		r.ChartVersion, r.ValuesYAML, r.Status, nullStr(r.ArgoCDAppName), r.DisplayName,
		r.ServiceName, r.Cluster, r.Namespace, r.DeletedAt, r.ID, r.Version)
	if isUniqueViolation(err) {
		return models.ErrConflict // identity collides with another active order
	}
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// either missing or version mismatch
		if _, gerr := p.GetRequest(ctx, r.ID); errors.Is(gerr, models.ErrNotFound) {
			return models.ErrNotFound
		}
		return models.ErrStaleVersion
	}
	r.Version++
	return nil
}

// SetDrift updates only the drift columns. It deliberately does NOT bump version
// or updated_at - drift is a system-observed signal, not a user edit, so it must
// not collide with optimistic locking on concurrent edits.
func (p *Postgres) SetDrift(ctx context.Context, id string, drifted bool, detail string) error {
	tag, err := p.pool.Exec(ctx, `UPDATE requests SET drifted=$1, drift_detail=$2 WHERE id=$3`,
		drifted, detail, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return models.ErrNotFound
	}
	return nil
}

func (p *Postgres) ListActive(ctx context.Context) ([]*models.Request, error) {
	rows, err := p.pool.Query(ctx, `SELECT `+reqCols+`
		FROM requests
		WHERE deleted_at IS NULL AND status NOT IN ('DELETED','MR_CLOSED')`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.Request
	for rows.Next() {
		r, err := scanRequest(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (p *Postgres) AddMR(ctx context.Context, mr *models.RequestMR) error {
	_, err := p.pool.Exec(ctx, `
		INSERT INTO request_mrs (id, request_id, gitlab_project_id, mr_iid, mr_url, mr_status, action)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		mr.ID, mr.RequestID, mr.GitLabProjectID, mr.MRIID, mr.MRURL, mr.Status, mr.Action)
	return err
}

func (p *Postgres) UpdateMR(ctx context.Context, mr *models.RequestMR) error {
	tag, err := p.pool.Exec(ctx, `UPDATE request_mrs SET mr_status=$1 WHERE id=$2`, mr.Status, mr.ID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return models.ErrNotFound
	}
	return nil
}

func scanMR(row pgx.Row) (*models.RequestMR, error) {
	var mr models.RequestMR
	err := row.Scan(&mr.ID, &mr.RequestID, &mr.GitLabProjectID, &mr.MRIID, &mr.MRURL,
		&mr.Status, &mr.Action, &mr.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, models.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &mr, nil
}

const mrCols = `id, request_id, gitlab_project_id, mr_iid, mr_url, mr_status, action, created_at`

func (p *Postgres) ListMRs(ctx context.Context, requestID string) ([]*models.RequestMR, error) {
	rows, err := p.pool.Query(ctx, `SELECT `+mrCols+` FROM request_mrs WHERE request_id=$1 ORDER BY created_at`, requestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.RequestMR
	for rows.Next() {
		mr, err := scanMR(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, mr)
	}
	return out, rows.Err()
}

func (p *Postgres) GetOpenMR(ctx context.Context, requestID string) (*models.RequestMR, error) {
	return scanMR(p.pool.QueryRow(ctx, `SELECT `+mrCols+`
		FROM request_mrs WHERE request_id=$1 AND mr_status='opened'
		ORDER BY created_at DESC LIMIT 1`, requestID))
}

func (p *Postgres) AddEvent(ctx context.Context, e *models.RequestEvent) error {
	var payload []byte
	if e.Payload != nil {
		payload, _ = json.Marshal(e.Payload)
	}
	return p.pool.QueryRow(ctx, `
		INSERT INTO request_events (request_id, actor, event_type, from_status, to_status, payload)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
		e.RequestID, nullStr(e.Actor), e.EventType, nullStatus(e.FromStatus), nullStatus(e.ToStatus), payload).
		Scan(&e.ID, &e.CreatedAt)
}

func (p *Postgres) ListEvents(ctx context.Context, requestID string) ([]*models.RequestEvent, error) {
	rows, err := p.pool.Query(ctx, `
		SELECT id, request_id, COALESCE(actor,''), event_type, COALESCE(from_status,''),
		       COALESCE(to_status,''), payload, created_at
		FROM request_events WHERE request_id=$1 ORDER BY created_at, id`, requestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.RequestEvent
	for rows.Next() {
		var e models.RequestEvent
		var payload []byte
		if err := rows.Scan(&e.ID, &e.RequestID, &e.Actor, &e.EventType, &e.FromStatus,
			&e.ToStatus, &payload, &e.CreatedAt); err != nil {
			return nil, err
		}
		if len(payload) > 0 {
			_ = json.Unmarshal(payload, &e.Payload)
		}
		out = append(out, &e)
	}
	return out, rows.Err()
}

func (p *Postgres) Ping(ctx context.Context) error { return p.pool.Ping(ctx) }
func (p *Postgres) Close()                         { p.pool.Close() }

// helpers
func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func nullStatus(s models.RequestStatus) any {
	if s == "" {
		return nil
	}
	return string(s)
}
func itoa(i int) string { return strconv.Itoa(i) }
