package argocd

import (
	"context"
	"sort"
	"sync"

	"console/pkg/models"
	"gopkg.in/yaml.v3"
)

// ManifestSource yields the application.yaml manifests currently committed on
// default branches. The fake GitLab implements it, so the fake ArgoCD can
// reconcile apps from "git" exactly like the real controller.
type ManifestSource interface {
	ListApplicationManifests(ctx context.Context) ([][]byte, error)
}

type appManifest struct {
	Metadata struct {
		Name   string            `yaml:"name"`
		Labels map[string]string `yaml:"labels"`
	} `yaml:"metadata"`
	Spec struct {
		Project     string `yaml:"project"`
		Destination struct {
			Name string `yaml:"name"`
		} `yaml:"destination"`
	} `yaml:"spec"`
}

// Fake is an in-memory ArgoCD. New apps start Progressing and advance to
// Healthy on the next Reconcile (deterministic one-tick progression).
type Fake struct {
	mu     sync.Mutex
	apps   map[string]*Application
	source ManifestSource
}

var _ Port = (*Fake)(nil)

// NewFake builds a fake ArgoCD. source may be nil (then use Upsert in tests).
func NewFake(source ManifestSource) *Fake {
	return &Fake{apps: map[string]*Application{}, source: source}
}

// Reconcile syncs the app set from the manifest source and advances health.
func (f *Fake) Reconcile(ctx context.Context) error {
	if f.source == nil {
		return nil
	}
	manifests, err := f.source.ListApplicationManifests(ctx)
	if err != nil {
		return err
	}
	desired := map[string]*Application{}
	for _, m := range manifests {
		var am appManifest
		if err := yaml.Unmarshal(m, &am); err != nil || am.Metadata.Name == "" {
			continue
		}
		desired[am.Metadata.Name] = &Application{
			Name:    am.Metadata.Name,
			Project: am.Spec.Project,
			Cluster: am.Spec.Destination.Name,
			Labels:  am.Metadata.Labels,
		}
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	// remove apps no longer in git
	for name := range f.apps {
		if _, ok := desired[name]; !ok {
			delete(f.apps, name)
		}
	}
	// add/advance
	for name, d := range desired {
		cur, ok := f.apps[name]
		if !ok {
			d.Sync = SyncOutOfSync
			d.Health = HealthProgressing
			f.apps[name] = d
			continue
		}
		// keep latest metadata, advance health one step
		cur.Project, cur.Cluster, cur.Labels = d.Project, d.Cluster, d.Labels
		if cur.Health == HealthProgressing {
			cur.Health = HealthHealthy
			cur.Sync = SyncSynced
		}
	}
	return nil
}

func (f *Fake) ListApplications(ctx context.Context, selector map[string]string) ([]Application, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Application
	for _, a := range f.apps {
		if matches(a.Labels, selector) {
			out = append(out, *a)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (f *Fake) GetApplication(ctx context.Context, name string) (*Application, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.apps[name]
	if !ok {
		return nil, models.ErrNotFound
	}
	cp := *a
	return &cp, nil
}

func (f *Fake) Sync(ctx context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.apps[name]
	if !ok {
		return models.ErrNotFound
	}
	a.Sync = SyncSynced
	return nil
}

func (f *Fake) Healthz(ctx context.Context) error { return nil }

// Upsert directly sets an app (test helper, bypasses reconcile).
func (f *Fake) Upsert(a Application) {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := a
	f.apps[a.Name] = &cp
}

func matches(labels, selector map[string]string) bool {
	for k, v := range selector {
		if labels[k] != v {
			return false
		}
	}
	return true
}
