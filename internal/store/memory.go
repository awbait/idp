package store

import (
	"context"
	"sort"
	"sync"
	"time"

	"console/pkg/models"
)

// Memory is an in-memory Store for tests and local fakes-only runs.
type Memory struct {
	mu        sync.Mutex
	requests  map[string]*models.Request
	mrs       map[string]*models.RequestMR
	events    []*models.RequestEvent
	eventSeq  int64
	categories map[string]*models.Category
	pubs       map[string]*models.ChartPublication
	pubEvents  []*models.PublicationEvent
	pubEventSeq int64
	now       func() time.Time
	lastStamp time.Time
}

var _ Store = (*Memory)(nil)

// NewMemory returns an empty in-memory store.
func NewMemory() *Memory {
	return &Memory{
		requests:   map[string]*models.Request{},
		mrs:        map[string]*models.RequestMR{},
		categories: map[string]*models.Category{},
		pubs:       map[string]*models.ChartPublication{},
		now:        time.Now,
	}
}

func clone[T any](v *T) *T { cp := *v; return &cp }

// stamp returns a strictly increasing timestamp so insertion order is
// recoverable even when the wall clock has coarse resolution (e.g. Windows,
// where two quick calls can return the same time). Callers must hold m.mu.
func (m *Memory) stamp() time.Time {
	t := m.now()
	if !t.After(m.lastStamp) {
		t = m.lastStamp.Add(time.Nanosecond)
	}
	m.lastStamp = t
	return t
}

// activeKey is the uniqueness key for non-deleted requests.
func activeKey(r *models.Request) string {
	return r.Team + "\x00" + r.ChartName + "\x00" + r.ServiceName + "\x00" + r.Cluster
}

func (m *Memory) CreateRequest(ctx context.Context, r *models.Request) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r.DeletedAt == nil {
		for _, ex := range m.requests {
			if ex.DeletedAt == nil && activeKey(ex) == activeKey(r) {
				return models.ErrConflict
			}
		}
	}
	if r.Version == 0 {
		r.Version = 1
	}
	now := m.stamp()
	if r.CreatedAt.IsZero() {
		r.CreatedAt = now
	}
	r.UpdatedAt = now
	m.requests[r.ID] = clone(r)
	return nil
}

func (m *Memory) GetRequest(ctx context.Context, id string) (*models.Request, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.requests[id]
	if !ok {
		return nil, models.ErrNotFound
	}
	return clone(r), nil
}

func (m *Memory) ListRequests(ctx context.Context, f RequestFilter) ([]*models.Request, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*models.Request
	for _, r := range m.requests {
		if !f.IncludeDeleted && r.DeletedAt != nil {
			continue
		}
		if !f.Admin && len(f.Teams) > 0 && !contains(f.Teams, r.Team) {
			continue
		}
		if f.Team != "" && r.Team != f.Team {
			continue
		}
		if f.Status != "" && r.Status != f.Status {
			continue
		}
		if f.Chart != "" && r.ChartName != f.Chart {
			continue
		}
		out = append(out, clone(r))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (m *Memory) UpdateRequest(ctx context.Context, r *models.Request) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.requests[r.ID]
	if !ok {
		return models.ErrNotFound
	}
	if cur.Version != r.Version {
		return models.ErrStaleVersion
	}
	// Identity may change while a DRAFT; guard against colliding with another
	// active order (mirrors the partial unique index in Postgres).
	if r.DeletedAt == nil && activeKey(r) != activeKey(cur) {
		for id, ex := range m.requests {
			if id != r.ID && ex.DeletedAt == nil && activeKey(ex) == activeKey(r) {
				return models.ErrConflict
			}
		}
	}
	r.Version = cur.Version + 1
	r.UpdatedAt = m.stamp()
	r.CreatedAt = cur.CreatedAt
	m.requests[r.ID] = clone(r)
	return nil
}

// SetDrift updates only the drift fields (no version bump), matching Postgres.
func (m *Memory) SetDrift(ctx context.Context, id string, drifted bool, detail string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.requests[id]
	if !ok {
		return models.ErrNotFound
	}
	r.Drifted = drifted
	r.DriftDetail = detail
	return nil
}

func (m *Memory) ListActive(ctx context.Context) ([]*models.Request, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*models.Request
	for _, r := range m.requests {
		if r.DeletedAt != nil {
			continue
		}
		if isTerminal(r.Status) {
			continue
		}
		out = append(out, clone(r))
	}
	return out, nil
}

func (m *Memory) AddMR(ctx context.Context, mr *models.RequestMR) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if mr.CreatedAt.IsZero() {
		mr.CreatedAt = m.stamp()
	}
	m.mrs[mr.ID] = clone(mr)
	return nil
}

func (m *Memory) UpdateMR(ctx context.Context, mr *models.RequestMR) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.mrs[mr.ID]; !ok {
		return models.ErrNotFound
	}
	m.mrs[mr.ID] = clone(mr)
	return nil
}

func (m *Memory) ListMRs(ctx context.Context, requestID string) ([]*models.RequestMR, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*models.RequestMR
	for _, mr := range m.mrs {
		if mr.RequestID == requestID {
			out = append(out, clone(mr))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out, nil
}

func (m *Memory) GetOpenMR(ctx context.Context, requestID string) (*models.RequestMR, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, mr := range m.mrs {
		if mr.RequestID == requestID && mr.Status == models.MROpened {
			return clone(mr), nil
		}
	}
	return nil, models.ErrNotFound
}

func (m *Memory) AddEvent(ctx context.Context, e *models.RequestEvent) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.eventSeq++
	e.ID = m.eventSeq
	if e.CreatedAt.IsZero() {
		e.CreatedAt = m.stamp()
	}
	m.events = append(m.events, clone(e))
	return nil
}

func (m *Memory) ListEvents(ctx context.Context, requestID string) ([]*models.RequestEvent, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []*models.RequestEvent
	for _, e := range m.events {
		if e.RequestID == requestID {
			out = append(out, clone(e))
		}
	}
	return out, nil
}

func (m *Memory) Ping(ctx context.Context) error { return nil }
func (m *Memory) Close()                          {}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// isTerminal reports whether a status needs no further status polling.
func isTerminal(s models.RequestStatus) bool {
	switch s {
	case models.StatusDeleted, models.StatusMRClosed:
		return true
	default:
		return false
	}
}
