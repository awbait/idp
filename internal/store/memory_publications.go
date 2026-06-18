package store

import (
	"context"
	"sort"

	"console/pkg/models"
)

// --- categories ---

func (m *Memory) CreateCategory(ctx context.Context, c *models.Category) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.categories[c.ID]; ok {
		return models.ErrConflict
	}
	m.categories[c.ID] = clone(c)
	return nil
}

func (m *Memory) UpdateCategory(ctx context.Context, c *models.Category) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.categories[c.ID]; !ok {
		return models.ErrNotFound
	}
	m.categories[c.ID] = clone(c)
	return nil
}

func (m *Memory) DeleteCategory(ctx context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.categories[id]; !ok {
		return models.ErrNotFound
	}
	// Mirrors the FK RESTRICT in Postgres: referenced categories can't go.
	for _, p := range m.pubs {
		if p.CategoryID == id {
			return models.ErrConflict
		}
	}
	delete(m.categories, id)
	return nil
}

func (m *Memory) ListCategories(ctx context.Context) ([]*models.Category, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*models.Category
	for _, c := range m.categories {
		out = append(out, clone(c))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Sort != out[j].Sort {
			return out[i].Sort < out[j].Sort
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// --- chart publications ---

func chartKey(project, name string) string { return project + "\x00" + name }

func (m *Memory) CreatePublication(ctx context.Context, p *models.ChartPublication) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, ex := range m.pubs {
		if chartKey(ex.ChartProject, ex.ChartName) == chartKey(p.ChartProject, p.ChartName) {
			return models.ErrConflict
		}
	}
	if p.Version == 0 {
		p.Version = 1
	}
	now := m.stamp()
	if p.CreatedAt.IsZero() {
		p.CreatedAt = now
	}
	p.UpdatedAt = now
	m.pubs[p.ID] = clone(p)
	return nil
}

func (m *Memory) GetPublication(ctx context.Context, id string) (*models.ChartPublication, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.pubs[id]
	if !ok {
		return nil, models.ErrNotFound
	}
	return clone(p), nil
}

func (m *Memory) GetPublicationByChart(ctx context.Context, project, name string) (*models.ChartPublication, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, p := range m.pubs {
		if p.ChartProject == project && p.ChartName == name {
			return clone(p), nil
		}
	}
	return nil, models.ErrNotFound
}

func (m *Memory) ListPublications(ctx context.Context, f PublicationFilter) ([]*models.ChartPublication, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*models.ChartPublication
	for _, p := range m.pubs {
		if f.Status != "" && p.Status != f.Status {
			continue
		}
		if f.Team != "" && p.OwnerTeam != f.Team {
			continue
		}
		if f.Chart != "" && p.ChartName != f.Chart {
			continue
		}
		out = append(out, clone(p))
	}
	sort.Slice(out, func(i, j int) bool {
		return chartKey(out[i].ChartProject, out[i].ChartName) < chartKey(out[j].ChartProject, out[j].ChartName)
	})
	return out, nil
}

func (m *Memory) UpdatePublication(ctx context.Context, p *models.ChartPublication) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.pubs[p.ID]
	if !ok {
		return models.ErrNotFound
	}
	if cur.Version != p.Version {
		return models.ErrStaleVersion
	}
	p.Version = cur.Version + 1
	p.UpdatedAt = m.stamp()
	p.CreatedAt = cur.CreatedAt
	m.pubs[p.ID] = clone(p)
	return nil
}

func (m *Memory) AddPublicationEvent(ctx context.Context, e *models.PublicationEvent) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pubEventSeq++
	e.ID = m.pubEventSeq
	if e.CreatedAt.IsZero() {
		e.CreatedAt = m.stamp()
	}
	m.pubEvents = append(m.pubEvents, clone(e))
	return nil
}

func (m *Memory) ListPublicationEvents(ctx context.Context, publicationID string) ([]*models.PublicationEvent, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*models.PublicationEvent
	for _, e := range m.pubEvents {
		if e.PublicationID == publicationID {
			out = append(out, clone(e))
		}
	}
	return out, nil
}
