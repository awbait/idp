package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"console/pkg/models"
)

// --- categories ---

func (p *Postgres) CreateCategory(ctx context.Context, c *models.Category) error {
	_, err := p.db.Exec(ctx, `INSERT INTO categories (id, label, sort, icon) VALUES ($1,$2,$3,$4)`,
		c.ID, c.Label, c.Sort, c.Icon)
	if isUniqueViolation(err) {
		return models.ErrConflict
	}
	return err
}

func (p *Postgres) UpdateCategory(ctx context.Context, c *models.Category) error {
	tag, err := p.db.Exec(ctx, `UPDATE categories SET label=$1, sort=$2, icon=$3 WHERE id=$4`,
		c.Label, c.Sort, c.Icon, c.ID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return models.ErrNotFound
	}
	return nil
}

func (p *Postgres) DeleteCategory(ctx context.Context, id string) error {
	tag, err := p.db.Exec(ctx, `DELETE FROM categories WHERE id=$1`, id)
	if isFKViolation(err) {
		return models.ErrConflict // category is referenced by publications
	}
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return models.ErrNotFound
	}
	return nil
}

func (p *Postgres) ListCategories(ctx context.Context) ([]*models.Category, error) {
	rows, err := p.db.Query(ctx, `SELECT id, label, sort, icon FROM categories ORDER BY sort, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.Category
	for rows.Next() {
		var c models.Category
		if err := rows.Scan(&c.ID, &c.Label, &c.Sort, &c.Icon); err != nil {
			return nil, err
		}
		out = append(out, &c)
	}
	return out, rows.Err()
}

// --- chart publications ---

const pubCols = `id, chart_project, chart_name, category_id, owner_team,
	created_by, created_by_name, status, view_json, approved_view_json,
	COALESCE(reviewed_by,''), COALESCE(review_comment,''), version, created_at, updated_at,
	draft_category_id, draft_owner_team, approved_view_version, approved_description, approved_icon_url`

func scanPublication(row pgx.Row) (*models.ChartPublication, error) {
	var pub models.ChartPublication
	var view, approved []byte
	err := row.Scan(&pub.ID, &pub.ChartProject, &pub.ChartName, &pub.CategoryID, &pub.OwnerTeam,
		&pub.CreatedBy, &pub.CreatedByName, &pub.Status, &view, &approved,
		&pub.ReviewedBy, &pub.ReviewComment, &pub.Version, &pub.CreatedAt, &pub.UpdatedAt,
		&pub.DraftCategoryID, &pub.DraftOwnerTeam, &pub.ApprovedViewVersion, &pub.ApprovedDescription,
		&pub.ApprovedIconURL)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, models.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	pub.ViewJSON = view
	pub.ApprovedViewJSON = approved
	return &pub, nil
}

func (p *Postgres) CreatePublication(ctx context.Context, pub *models.ChartPublication) error {
	if pub.Version == 0 {
		pub.Version = 1
	}
	_, err := p.db.Exec(ctx, `
		INSERT INTO chart_publications
		(id, chart_project, chart_name, category_id, owner_team, created_by, created_by_name,
		 status, view_json, approved_view_json, reviewed_by, review_comment, version,
		 draft_category_id, draft_owner_team, approved_view_version, approved_description,
		 approved_icon_url)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
		pub.ID, pub.ChartProject, pub.ChartName, pub.CategoryID, pub.OwnerTeam,
		pub.CreatedBy, pub.CreatedByName, pub.Status, nullJSON(pub.ViewJSON),
		nullJSON(pub.ApprovedViewJSON), pub.ReviewedBy, pub.ReviewComment, pub.Version,
		pub.DraftCategoryID, pub.DraftOwnerTeam, pub.ApprovedViewVersion, pub.ApprovedDescription,
		pub.ApprovedIconURL)
	if isUniqueViolation(err) {
		return models.ErrConflict
	}
	return err
}

func (p *Postgres) GetPublication(ctx context.Context, id string) (*models.ChartPublication, error) {
	return scanPublication(p.db.QueryRow(ctx,
		`SELECT `+pubCols+` FROM chart_publications WHERE id=$1`, id))
}

func (p *Postgres) GetPublicationByChart(ctx context.Context, project, name string) (*models.ChartPublication, error) {
	return scanPublication(p.db.QueryRow(ctx,
		`SELECT `+pubCols+` FROM chart_publications WHERE chart_project=$1 AND chart_name=$2`, project, name))
}

func (p *Postgres) ListPublications(ctx context.Context, f PublicationFilter) ([]*models.ChartPublication, error) {
	q := `SELECT ` + pubCols + ` FROM chart_publications WHERE 1=1`
	args := []any{}
	add := func(cond string, v any) { args = append(args, v); q += cond + "$" + itoa(len(args)) }

	if f.Status != "" {
		add(" AND status=", string(f.Status))
	}
	if f.Team != "" {
		add(" AND owner_team=", f.Team)
	}
	if f.Chart != "" {
		add(" AND chart_name=", f.Chart)
	}
	q += " ORDER BY chart_project, chart_name"

	rows, err := p.db.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.ChartPublication
	for rows.Next() {
		pub, err := scanPublication(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, pub)
	}
	return out, rows.Err()
}

func (p *Postgres) UpdatePublication(ctx context.Context, pub *models.ChartPublication) error {
	tag, err := p.db.Exec(ctx, `
		UPDATE chart_publications SET
		  category_id=$1, owner_team=$2, draft_category_id=$3, draft_owner_team=$4,
		  status=$5, view_json=$6, approved_view_json=$7,
		  reviewed_by=$8, review_comment=$9, approved_view_version=$10, approved_description=$11,
		  approved_icon_url=$12,
		  version=version+1, updated_at=NOW()
		WHERE id=$13 AND version=$14`,
		pub.CategoryID, pub.OwnerTeam, pub.DraftCategoryID, pub.DraftOwnerTeam,
		pub.Status, nullJSON(pub.ViewJSON),
		nullJSON(pub.ApprovedViewJSON), pub.ReviewedBy, pub.ReviewComment, pub.ApprovedViewVersion,
		pub.ApprovedDescription, pub.ApprovedIconURL, pub.ID, pub.Version)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		if _, gerr := p.GetPublication(ctx, pub.ID); errors.Is(gerr, models.ErrNotFound) {
			return models.ErrNotFound
		}
		return models.ErrStaleVersion
	}
	pub.Version++
	return nil
}

func (p *Postgres) AddPublicationEvent(ctx context.Context, e *models.PublicationEvent) error {
	var payload []byte
	if e.Payload != nil {
		b, err := json.Marshal(e.Payload)
		if err != nil {
			return fmt.Errorf("marshal publication event payload: %w", err)
		}
		payload = b
	}
	return p.db.QueryRow(ctx, `
		INSERT INTO publication_events (publication_id, actor, event_type, from_status, to_status, payload)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
		e.PublicationID, nullStr(e.Actor), e.EventType, nullPubStatus(e.FromStatus), nullPubStatus(e.ToStatus), payload).
		Scan(&e.ID, &e.CreatedAt)
}

func (p *Postgres) ListPublicationEvents(ctx context.Context, publicationID string) ([]*models.PublicationEvent, error) {
	rows, err := p.db.Query(ctx, `
		SELECT id, publication_id, COALESCE(actor,''), event_type, COALESCE(from_status,''),
		       COALESCE(to_status,''), payload, created_at
		FROM publication_events WHERE publication_id=$1 ORDER BY created_at, id`, publicationID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*models.PublicationEvent
	for rows.Next() {
		var e models.PublicationEvent
		var payload []byte
		if err := rows.Scan(&e.ID, &e.PublicationID, &e.Actor, &e.EventType, &e.FromStatus,
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

// helpers

func isFKViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

func nullJSON(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return b
}

func nullPubStatus(s models.PublicationStatus) any {
	if s == "" {
		return nil
	}
	return string(s)
}
