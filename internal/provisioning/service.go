// Package provisioning owns the order lifecycle: form -> MR -> ArgoCD.
package provisioning

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"time"

	"github.com/google/uuid"
	"github.com/santhosh-tekuri/jsonschema/v5"
	"gopkg.in/yaml.v3"
	"console/internal/argocd"
	"console/internal/catalog"
	"console/internal/events"
	"console/internal/gitlab"
	"console/internal/store"
	"console/pkg/models"
)

var nameRe = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

var allDigitsRe = regexp.MustCompile(`^[0-9]+$`)

// validNamespace: DNS-1123 label and not purely numeric (a numeric namespace
// is almost certainly a typo, and some tools choke on such a name).
func validNamespace(ns string) bool {
	return nameRe.MatchString(ns) && len(ns) <= 63 && !allDigitsRe.MatchString(ns)
}

// Service is the provisioning domain.
type Service struct {
	store          store.Store
	gl             gitlab.Port
	argo           argocd.Port
	catalog        *catalog.Service
	gitops         *GitOps
	bus            *events.Bus
	defaultCluster string
	defaultBranch  string
	// autoMerge makes the poller merge open portal MRs itself (no human gate).
	// Convenient for local/demo against real GitLab; off in production.
	autoMerge bool
	// Log is the structured logger; wired by main. Nil-safe via logger().
	Log *slog.Logger
}

// logger returns the configured logger, or the default if none was wired (tests).
func (s *Service) logger() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

// New builds a provisioning service.
func New(st store.Store, gl gitlab.Port, argo argocd.Port, cat *catalog.Service,
	g *GitOps, bus *events.Bus, defaultCluster, defaultBranch string, autoMerge bool) *Service {
	return &Service{store: st, gl: gl, argo: argo, catalog: cat, gitops: g,
		bus: bus, defaultCluster: defaultCluster, defaultBranch: defaultBranch, autoMerge: autoMerge}
}

// CreateInput is the payload for a new order.
type CreateInput struct {
	ChartProject string
	ChartName    string
	Version      string
	Team         string
	ServiceName  string
	DisplayName  string // optional; cosmetic. Defaults to ServiceName when empty.
	Cluster      string // ArgoCD destination cluster; defaults to the configured cluster when empty.
	Namespace    string // ArgoCD destination namespace; defaults to ServiceName when empty.
	Values       map[string]any
	// Draft persists the order in DRAFT without opening an MR. Its values may be
	// incomplete (schema validation is deferred to Submit).
	Draft bool
}

// UpdateInput patches an existing order. ServiceName/DisplayName are honoured
// only while the order is still a DRAFT (the deploy identity is immutable once
// an MR exists).
type UpdateInput struct {
	Version     string // optional new chart version
	ServiceName string // draft only: change the deploy identity
	DisplayName string // draft only: change the cosmetic name
	Cluster     string // draft only: change the destination cluster
	Namespace   string // draft only: change the destination namespace
	Values      map[string]any
}

// canView / canEdit hold for admins and support across every team, and for
// members within their own team. canEdit gates value changes on an existing
// order (update, rename, upgrade).
func canView(u *models.User, team string) bool {
	return u.IsAdmin() || u.IsSupport() || u.InTeam(team)
}
func canEdit(u *models.User, team string) bool {
	return u.IsAdmin() || u.IsSupport() || u.InTeam(team)
}

// canProvision gates lifecycle actions that create or destroy an instance
// (create, submit, delete). Support is intentionally excluded: it operates on
// existing orders but does not stand up or tear down services.
func canProvision(u *models.User, team string) bool {
	return u.IsAdmin() || u.InTeam(team)
}

func shortID() string { return uuid.NewString()[:8] }

// newID returns a UUIDv7 (time-ordered) for DB primary keys: better B-tree
// index locality and roughly creation-sortable, unlike random v4.
func newID() string { return uuid.Must(uuid.NewV7()).String() }

// --- reads ---

// Get returns an order the user is allowed to see.
func (s *Service) Get(ctx context.Context, u *models.User, id string) (*models.Request, error) {
	r, err := s.store.GetRequest(ctx, id)
	if err != nil {
		return nil, err
	}
	if !canView(u, r.Team) {
		return nil, ErrForbidden
	}
	return r, nil
}

// List returns orders visible to the user (scoped to their teams unless admin).
func (s *Service) List(ctx context.Context, u *models.User, f store.RequestFilter) ([]*models.Request, error) {
	seesAll := u.IsAdmin() || u.IsSupport()
	// No scope -> no orders. The store filter treats an empty Teams set as
	// "unfiltered", so without this guard a role with no team (security/auditor)
	// would list every order - inconsistent with Get, which denies them.
	if !seesAll && len(u.Teams) == 0 {
		return []*models.Request{}, nil
	}
	f.Teams = u.Teams
	// Support sees every team's orders, same as admin (read/edit, not provision).
	f.Admin = seesAll
	return s.store.ListRequests(ctx, f)
}

// ListMRs / ListEvents expose order details.
func (s *Service) ListMRs(ctx context.Context, id string) ([]*models.RequestMR, error) {
	return s.store.ListMRs(ctx, id)
}
func (s *Service) ListEvents(ctx context.Context, id string) ([]*models.RequestEvent, error) {
	return s.store.ListEvents(ctx, id)
}

// --- create ---

// Create validates input and persists a DRAFT. Unless in.Draft is set it then
// opens the create MR and advances the order to MR_CREATED.
func (s *Service) Create(ctx context.Context, u *models.User, in CreateInput) (*models.Request, error) {
	if !canProvision(u, in.Team) {
		return nil, ErrForbidden
	}
	if !nameRe.MatchString(in.ServiceName) || len(in.ServiceName) > 63 {
		return nil, &ValidationError{Message: "service_name must be a valid Kubernetes name"}
	}
	if in.Namespace != "" && !validNamespace(in.Namespace) {
		return nil, &ValidationError{Message: "namespace должен быть валидным именем Kubernetes и не может быть числом"}
	}
	if _, err := s.catalog.GetVersion(ctx, in.ChartProject, in.ChartName, in.Version); err != nil {
		if errors.Is(err, models.ErrNotFound) {
			return nil, &ValidationError{Message: "unknown chart or version"}
		}
		return nil, fmt.Errorf("%w: harbor: %v", ErrUpstream, err)
	}
	// A draft may hold incomplete values; defer schema validation to Submit.
	valuesYAML, err := s.validateAndMarshal(ctx, in.ChartProject, in.ChartName, in.Version, in.Values, !in.Draft)
	if err != nil {
		return nil, err
	}

	displayName := in.DisplayName
	if displayName == "" {
		displayName = in.ServiceName
	}
	cluster := in.Cluster
	if cluster == "" {
		cluster = s.defaultCluster
	}
	namespace := in.Namespace
	if namespace == "" {
		namespace = in.ServiceName
	}
	r := &models.Request{
		ID:            newID(),
		CreatedBy:     u.Subject,
		CreatedByName: u.Name,
		Team:          in.Team,
		ChartProject:  in.ChartProject,
		ChartName:     in.ChartName,
		ChartVersion:  in.Version,
		ServiceName:   in.ServiceName,
		DisplayName:   displayName,
		Cluster:       cluster,
		Namespace:     namespace,
		ValuesYAML:    valuesYAML,
		Status:        models.StatusDraft,
	}
	r.ArgoCDAppName = s.gitops.AppName(r.Team, r.ServiceName) // computed once

	if err := s.store.CreateRequest(ctx, r); err != nil {
		return nil, err // ErrConflict -> 409
	}
	s.event(ctx, r, u.Subject, "created", "", "")

	if in.Draft {
		return r, nil // stays DRAFT until Submit
	}

	proj, err := s.ensureRepo(ctx, r.Team, r.ChartName)
	if err != nil {
		return r, err // DRAFT persists; caller sees upstream error
	}
	appYAML, _ := s.gitops.RenderApplication(r, proj.WebURL)
	actions := []gitlab.FileAction{
		{Action: "create", FilePath: s.gitops.AppPath(r.Cluster, r.ServiceName), Content: appYAML},
		{Action: "create", FilePath: s.gitops.ValuesPath(r.Cluster, r.ServiceName), Content: valuesYAML},
	}
	if _, err := s.openChange(ctx, r, proj, models.ActionCreate, actions); err != nil {
		return r, err
	}
	if err := s.transition(ctx, r, models.StatusMRCreated, u.Subject); err != nil {
		return r, err
	}
	return r, nil
}

// --- submit ---

// Submit promotes a DRAFT order: it re-validates the stored values against the
// chart schema, opens the create MR, and advances to MR_CREATED.
func (s *Service) Submit(ctx context.Context, u *models.User, id string) (*models.Request, error) {
	r, err := s.store.GetRequest(ctx, id)
	if err != nil {
		return nil, err
	}
	if !canProvision(u, r.Team) {
		return nil, ErrForbidden
	}
	if r.DeletedAt != nil {
		return nil, models.ErrNotFound
	}
	if r.Status != models.StatusDraft {
		return nil, &ValidationError{Message: "only draft orders can be submitted"}
	}
	if !nameRe.MatchString(r.ServiceName) || len(r.ServiceName) > 63 {
		return nil, &ValidationError{Message: "service_name must be a valid Kubernetes name"}
	}
	var values map[string]any
	if uerr := yaml.Unmarshal([]byte(r.ValuesYAML), &values); uerr != nil {
		return nil, &ValidationError{Message: "invalid values: " + uerr.Error()}
	}
	valuesYAML, err := s.validateAndMarshal(ctx, r.ChartProject, r.ChartName, r.ChartVersion, values, true)
	if err != nil {
		return nil, err
	}
	r.ValuesYAML = valuesYAML

	proj, err := s.ensureRepo(ctx, r.Team, r.ChartName)
	if err != nil {
		return r, err
	}
	appYAML, _ := s.gitops.RenderApplication(r, proj.WebURL)
	actions := []gitlab.FileAction{
		{Action: "create", FilePath: s.gitops.AppPath(r.Cluster, r.ServiceName), Content: appYAML},
		{Action: "create", FilePath: s.gitops.ValuesPath(r.Cluster, r.ServiceName), Content: valuesYAML},
	}
	if _, err := s.openChange(ctx, r, proj, models.ActionCreate, actions); err != nil {
		return r, err
	}
	if err := s.transition(ctx, r, models.StatusMRCreated, u.Subject); err != nil {
		return r, err
	}
	return r, nil
}

// --- update ---

// Update patches an existing order. For a DRAFT it persists the form (values,
// version, and the still-mutable identity/display name) without an MR; for a
// live order it opens an update MR and advances to MR_CREATED.
func (s *Service) Update(ctx context.Context, u *models.User, id string, in UpdateInput) (*models.Request, error) {
	r, err := s.store.GetRequest(ctx, id)
	if err != nil {
		return nil, err
	}
	if !canEdit(u, r.Team) {
		return nil, ErrForbidden
	}
	if r.DeletedAt != nil {
		return nil, models.ErrNotFound
	}
	if r.Status == models.StatusDraft {
		return s.updateDraft(ctx, u, r, in)
	}
	// Guard the FSM edge BEFORE touching Git: a live order can be edited only from
	// a state that may advance to MR_CREATED (i.e. once the create MR is merged).
	// Checking first avoids opening an update MR we then can't transition into,
	// which would leave a dangling open MR (mirrors the delete guard).
	if !CanTransition(r.Status, models.StatusMRCreated) {
		return nil, &ValidationError{Message: "service can only be edited after its create merge request is merged (current status: " + string(r.Status) + ")"}
	}
	if err := s.guardOpenMR(ctx, id); err != nil {
		return nil, err
	}

	version := r.ChartVersion
	if in.Version != "" {
		version = in.Version
	}
	valuesYAML, err := s.validateAndMarshal(ctx, r.ChartProject, r.ChartName, version, in.Values, true)
	if err != nil {
		return nil, err
	}

	proj, err := s.ensureRepo(ctx, r.Team, r.ChartName)
	if err != nil {
		return nil, err
	}
	r.ChartVersion = version
	r.ValuesYAML = valuesYAML
	appYAML, _ := s.gitops.RenderApplication(r, proj.WebURL)
	actions := []gitlab.FileAction{
		{Action: "update", FilePath: s.gitops.AppPath(r.Cluster, r.ServiceName), Content: appYAML},
		{Action: "update", FilePath: s.gitops.ValuesPath(r.Cluster, r.ServiceName), Content: valuesYAML},
	}
	if _, err := s.openChange(ctx, r, proj, models.ActionUpdate, actions); err != nil {
		return nil, err
	}
	if err := s.transition(ctx, r, models.StatusMRCreated, u.Subject); err != nil {
		return nil, err
	}
	return r, nil
}

// updateDraft persists draft edits (values, version, identity, display name)
// without opening an MR. Values may be incomplete, so schema validation is
// deferred to Submit.
func (s *Service) updateDraft(ctx context.Context, u *models.User, r *models.Request, in UpdateInput) (*models.Request, error) {
	if in.Version != "" && in.Version != r.ChartVersion {
		if _, err := s.catalog.GetVersion(ctx, r.ChartProject, r.ChartName, in.Version); err != nil {
			if errors.Is(err, models.ErrNotFound) {
				return nil, &ValidationError{Message: "unknown chart or version"}
			}
			return nil, fmt.Errorf("%w: harbor: %v", ErrUpstream, err)
		}
		r.ChartVersion = in.Version
	}
	if in.ServiceName != "" && in.ServiceName != r.ServiceName {
		if !nameRe.MatchString(in.ServiceName) || len(in.ServiceName) > 63 {
			return nil, &ValidationError{Message: "service_name must be a valid Kubernetes name"}
		}
		r.ServiceName = in.ServiceName
		r.ArgoCDAppName = s.gitops.AppName(r.Team, r.ServiceName)
	}
	if in.DisplayName != "" {
		r.DisplayName = in.DisplayName
	}
	if in.Cluster != "" {
		r.Cluster = in.Cluster
	}
	if in.Namespace != "" {
		if !validNamespace(in.Namespace) {
			return nil, &ValidationError{Message: "namespace должен быть валидным именем Kubernetes и не может быть числом"}
		}
		r.Namespace = in.Namespace
	}
	valuesYAML, err := s.validateAndMarshal(ctx, r.ChartProject, r.ChartName, r.ChartVersion, in.Values, false)
	if err != nil {
		return nil, err
	}
	r.ValuesYAML = valuesYAML
	if err := s.store.UpdateRequest(ctx, r); err != nil {
		return nil, err // ErrConflict (identity collision) / ErrStaleVersion
	}
	s.event(ctx, r, u.Subject, "draft_updated", "", "")
	return r, nil
}

// Rename changes only the cosmetic display name. It never opens an MR and works
// in any non-deleted status - the display name doesn't affect the deployment.
func (s *Service) Rename(ctx context.Context, u *models.User, id, displayName string) (*models.Request, error) {
	r, err := s.store.GetRequest(ctx, id)
	if err != nil {
		return nil, err
	}
	if !canEdit(u, r.Team) {
		return nil, ErrForbidden
	}
	if r.DeletedAt != nil {
		return nil, models.ErrNotFound
	}
	// Name unchanged - write nothing and don't emit a "renamed" event.
	if displayName == r.DisplayName {
		return r, nil
	}
	r.DisplayName = displayName
	if err := s.store.UpdateRequest(ctx, r); err != nil {
		return nil, err
	}
	s.event(ctx, r, u.Subject, "renamed", "", "")
	return r, nil
}

// --- delete (soft) ---

// Delete opens an MR removing the instance folder and marks DELETE_REQUESTED.
func (s *Service) Delete(ctx context.Context, u *models.User, id string) (*models.Request, error) {
	r, err := s.store.GetRequest(ctx, id)
	if err != nil {
		return nil, err
	}
	if !canProvision(u, r.Team) {
		return nil, ErrForbidden
	}
	if r.DeletedAt != nil {
		return nil, models.ErrNotFound
	}
	// A draft has nothing in Git yet: discard it directly, no delete MR.
	if r.Status == models.StatusDraft {
		now := time.Now()
		r.DeletedAt = &now
		r.Status = models.StatusDeleted
		if err := s.store.UpdateRequest(ctx, r); err != nil {
			return nil, err
		}
		s.event(ctx, r, u.Subject, "draft_discarded", "", "")
		return r, nil
	}
	// Guard the FSM edge BEFORE touching Git: delete is only valid once the create
	// MR is merged (MR_MERGED/DEPLOYING/HEALTHY/DEGRADED/ARGO_MISSING), never while
	// the create MR is still open (MR_CREATED). Checking first avoids opening a
	// delete MR we then can't transition into DELETE_REQUESTED, which would leave a
	// dangling open MR the poller never auto-merges.
	if !CanTransition(r.Status, models.StatusDeleteRequested) {
		return nil, &ValidationError{Message: "service can only be deleted after its create merge request is merged (current status: " + string(r.Status) + ")"}
	}
	if err := s.guardOpenMR(ctx, id); err != nil {
		return nil, err
	}
	proj, err := s.ensureRepo(ctx, r.Team, r.ChartName)
	if err != nil {
		return nil, err
	}
	// delete every file in the instance folder
	files, terr := s.gl.ListTree(ctx, proj.ID, s.defaultBranch, s.gitops.InstanceDir(r.Cluster, r.ServiceName))
	if terr != nil {
		return nil, fmt.Errorf("%w: gitlab list tree: %v", ErrUpstream, terr)
	}
	if len(files) == 0 {
		// Nothing committed in Git for this instance - the manifests were removed
		// outside the portal (e.g. an imported order whose files are gone, or a
		// reset repo). There's no delete MR to open; close the order out directly
		// rather than committing a delete of files that don't exist (GitLab 400).
		now := time.Now()
		r.DeletedAt = &now
		r.Status = models.StatusDeleted
		if err := s.store.UpdateRequest(ctx, r); err != nil {
			return nil, err
		}
		s.event(ctx, r, u.Subject, "deleted", "", models.StatusDeleted)
		s.publishStatus(r.ID, string(models.StatusDeleted))
		return r, nil
	}
	actions := make([]gitlab.FileAction, 0, len(files))
	for _, f := range files {
		actions = append(actions, gitlab.FileAction{Action: "delete", FilePath: f})
	}
	if _, err := s.openChange(ctx, r, proj, models.ActionDelete, actions); err != nil {
		return nil, err
	}
	if err := s.transition(ctx, r, models.StatusDeleteRequested, u.Subject); err != nil {
		return nil, err
	}
	return r, nil
}

// ForceSync triggers an ArgoCD sync (admin only).
func (s *Service) ForceSync(ctx context.Context, u *models.User, id string) error {
	r, err := s.store.GetRequest(ctx, id)
	if err != nil {
		return err
	}
	if !u.IsAdmin() {
		return ErrForbidden
	}
	if err := s.argo.Sync(ctx, r.ArgoCDAppName); err != nil {
		return fmt.Errorf("%w: argocd: %v", ErrUpstream, err)
	}
	s.event(ctx, r, u.Subject, "sync_forced", "", "")
	return nil
}

// --- helpers ---

func (s *Service) guardOpenMR(ctx context.Context, id string) error {
	if _, err := s.store.GetOpenMR(ctx, id); err == nil {
		return ErrOpenMR
	} else if !errors.Is(err, models.ErrNotFound) {
		return err
	}
	return nil
}

// validateAndMarshal marshals values to YAML. When validate is true it first
// checks them against the chart's JSON schema (drafts pass false, since their
// values may still be incomplete).
func (s *Service) validateAndMarshal(ctx context.Context, project, name, version string, values map[string]any, validate bool) (string, error) {
	if values == nil {
		values = map[string]any{}
	}
	if !validate {
		out, merr := yaml.Marshal(values)
		if merr != nil {
			return "", &ValidationError{Message: "invalid values: " + merr.Error()}
		}
		return string(out), nil
	}
	schemaBytes, err := s.catalog.GetSchema(ctx, project, name, version)
	if err == nil && len(schemaBytes) > 0 {
		c := jsonschema.NewCompiler()
		if aerr := c.AddResource("values.schema.json", bytes.NewReader(schemaBytes)); aerr == nil {
			if sch, cerr := c.Compile("values.schema.json"); cerr == nil {
				if verr := sch.Validate(values); verr != nil {
					return "", schemaValidationError(verr)
				}
			}
		}
	} else if err != nil && !errors.Is(err, models.ErrNotFound) {
		return "", fmt.Errorf("%w: harbor schema: %v", ErrUpstream, err)
	}
	out, merr := yaml.Marshal(values)
	if merr != nil {
		return "", &ValidationError{Message: "invalid values: " + merr.Error()}
	}
	return string(out), nil
}

// schemaValidationError flattens a jsonschema failure into a ValidationError with
// a per-field breakdown (the leaf causes), so the UI can pinpoint bad fields.
func schemaValidationError(err error) *ValidationError {
	ve := &ValidationError{Message: "values failed schema validation"}
	var je *jsonschema.ValidationError
	if errors.As(err, &je) {
		collectSchemaLeaves(je, &ve.Fields)
	}
	if len(ve.Fields) == 0 {
		ve.Fields = []FieldError{{Message: err.Error()}}
	}
	return ve
}

// collectSchemaLeaves gathers the leaf validation errors (the actionable ones,
// each pinned to an instance location) from the error tree.
func collectSchemaLeaves(e *jsonschema.ValidationError, out *[]FieldError) {
	if len(e.Causes) == 0 {
		*out = append(*out, FieldError{Path: e.InstanceLocation, Message: e.Message})
		return
	}
	for _, c := range e.Causes {
		collectSchemaLeaves(c, out)
	}
}

// ensureRepo verifies the (manually-created) team subgroup and idempotently
// creates the chart repo.
func (s *Service) ensureRepo(ctx context.Context, team, chart string) (*gitlab.Project, error) {
	subgroup := s.gitops.SubgroupPath(team)
	grp, err := s.gl.GetGroup(ctx, subgroup)
	if err != nil {
		if errors.Is(err, models.ErrNotFound) {
			return nil, fmt.Errorf("%w: team subgroup %q not found (must be created manually)", ErrUpstream, subgroup)
		}
		return nil, fmt.Errorf("%w: gitlab: %v", ErrUpstream, err)
	}
	repoPath := s.gitops.RepoPath(team, chart)
	proj, err := s.gl.GetProject(ctx, repoPath)
	if errors.Is(err, models.ErrNotFound) {
		proj, err = s.gl.CreateProject(ctx, grp.ID, chart)
		if err != nil {
			return nil, fmt.Errorf("%w: gitlab create repo: %v", ErrUpstream, err)
		}
	} else if err != nil {
		return nil, fmt.Errorf("%w: gitlab: %v", ErrUpstream, err)
	}
	// A freshly created repo is empty (no default branch). The MR-based flow needs
	// a branch to open MRs against, so seed a single .gitkeep to establish it -
	// no README, keeping the repo otherwise empty. Idempotent: skip once a default
	// branch exists (also self-heals a repo left half-initialised by a past run).
	if proj.DefaultBranch == "" {
		seed := []gitlab.FileAction{{Action: "create", FilePath: ".gitkeep", Content: ""}}
		if cerr := s.gl.CommitFiles(ctx, proj.ID, s.defaultBranch, "chore: initialize repository", seed); cerr != nil {
			return nil, fmt.Errorf("%w: gitlab init repo: %v", ErrUpstream, cerr)
		}
		proj.DefaultBranch = s.defaultBranch
	}
	return proj, nil
}

// commitTitle builds a Conventional Commits message for a GitOps change (the
// commit subject). Scope is the instance, body names the chart.
func commitTitle(action models.MRAction, chart, service string) string {
	switch action {
	case models.ActionCreate:
		return fmt.Sprintf("feat(%s): add %s instance", service, chart)
	case models.ActionUpdate:
		return fmt.Sprintf("chore(%s): update %s values", service, chart)
	case models.ActionDelete:
		return fmt.Sprintf("chore(%s): remove %s instance", service, chart)
	default:
		return fmt.Sprintf("chore(%s): update", service)
	}
}

// mrTitle builds the merge-request title by a reviewer-friendly convention:
//
//	portal(<action>): <chart> "<service>" - <team>/<cluster>
//
// More descriptive than the bare commit subject so the MR list reads well in
// GitLab (what changed, which instance, which team/cluster).
func mrTitle(action models.MRAction, r *models.Request) string {
	verb := map[models.MRAction]string{
		models.ActionCreate: "deploy",
		models.ActionUpdate: "update",
		models.ActionDelete: "remove",
	}[action]
	if verb == "" {
		verb = "change"
	}
	return fmt.Sprintf("portal(%s): %s %q - %s/%s", verb, r.ChartName, r.ServiceName, r.Team, r.Cluster)
}

func (s *Service) openChange(ctx context.Context, r *models.Request, proj *gitlab.Project,
	action models.MRAction, actions []gitlab.FileAction) (*models.RequestMR, error) {

	commitMsg := commitTitle(action, r.ChartName, r.ServiceName)
	branch := fmt.Sprintf("portal/%s-%s-%s", action, r.ServiceName, shortID())
	if err := s.gl.CreateBranch(ctx, proj.ID, branch, s.defaultBranch); err != nil {
		return nil, fmt.Errorf("%w: gitlab branch: %v", ErrUpstream, err)
	}
	if err := s.gl.CommitFiles(ctx, proj.ID, branch, commitMsg, actions); err != nil {
		return nil, fmt.Errorf("%w: gitlab commit: %v", ErrUpstream, err)
	}
	mr, err := s.gl.CreateMR(ctx, proj.ID, branch, s.defaultBranch, mrTitle(action, r))
	if err != nil {
		return nil, fmt.Errorf("%w: gitlab mr: %v", ErrUpstream, err)
	}
	rec := &models.RequestMR{
		ID: newID(), RequestID: r.ID, GitLabProjectID: proj.ID,
		MRIID: mr.IID, MRURL: mr.WebURL, Status: mr.State, Action: action,
	}
	if err := s.store.AddMR(ctx, rec); err != nil {
		return nil, err
	}
	return rec, nil
}

// transition persists a status change with optimistic locking and emits events.
func (s *Service) transition(ctx context.Context, r *models.Request, to models.RequestStatus, actor string) error {
	from := r.Status
	if !CanTransition(from, to) {
		return fmt.Errorf("invalid transition %s -> %s", from, to)
	}
	r.Status = to
	if err := s.store.UpdateRequest(ctx, r); err != nil {
		return err
	}
	s.event(ctx, r, actor, "status_changed", from, to)
	s.publishStatus(r.ID, string(to))
	s.logger().Debug("order transition",
		"order_id", r.ID, "from", from, "to", to, "actor", actor)
	return nil
}

// publishStatus fans a status change out to the per-request topic (detail page)
// and the global "requests" topic (list views' live refresh).
func (s *Service) publishStatus(id, status string) {
	data := map[string]any{"id": id, "status": status}
	s.bus.Publish(events.Event{Topic: "request:" + id, Type: "status_changed", Data: data})
	s.bus.Publish(events.Event{Topic: "requests", Type: "status_changed", Data: data})
}

func (s *Service) event(ctx context.Context, r *models.Request, actor, typ string, from, to models.RequestStatus) {
	_ = s.store.AddEvent(ctx, &models.RequestEvent{
		RequestID: r.ID, Actor: actor, EventType: typ, FromStatus: from, ToStatus: to,
	})
}
