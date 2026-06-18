// Mirrors the Go backend domain models (pkg/models).

export type Role = "auditor" | "member" | "support" | "security" | "admin";

export interface User {
  sub: string;
  email: string;
  preferred_username: string;
  name: string;
  teams: string[];
  role: Role;
}

export interface Chart {
  project: string;
  name: string;
  description: string;
  icon_url?: string;
  latest_version: string;
  versions: string[];
  allowed_teams?: string[];
}

export interface ChartVersion {
  project: string;
  name: string;
  version: string;
  digest: string;
  app_version?: string;
  created: string;
  tags?: string[];
}

export interface ChangelogEntry {
  version: string;
  date?: string;
  sections: Record<string, string[]>;
}

export type RequestStatus =
  | "DRAFT"
  | "MR_CREATED"
  | "MR_CLOSED"
  | "MR_MERGED"
  | "DEPLOYING"
  | "HEALTHY"
  | "DEGRADED"
  | "ARGO_MISSING"
  | "DELETE_REQUESTED"
  | "DELETE_MR_MERGED"
  | "DELETED";

export interface OrderRequest {
  id: string;
  created_by: string;
  created_by_name: string;
  team: string;
  chart_project: string;
  chart_name: string;
  chart_version: string;
  service_name: string;
  display_name: string;
  cluster: string;
  namespace: string;
  values_yaml: string;
  status: RequestStatus;
  argocd_app_name: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  // Set when the order's committed Git state was changed outside the portal.
  drifted: boolean;
  drift_detail?: string;
  // True for orders discovered/adopted from Git (created outside the portal).
  imported: boolean;
}

export interface RequestMR {
  id: string;
  request_id: string;
  gitlab_project_id: number;
  mr_iid: number;
  mr_url: string;
  mr_status: string;
  action: string;
  created_at: string;
}

export interface RequestEvent {
  id: number;
  request_id: string;
  actor: string;
  event_type: string;
  from_status?: RequestStatus;
  to_status?: RequestStatus;
  created_at: string;
}

export interface RequestDetail {
  request: OrderRequest;
  merge_requests: RequestMR[] | null;
  events: RequestEvent[] | null;
  // Deep link to the order's ArgoCD Application; empty/absent when ArgoCD is not
  // configured or the app doesn't exist yet (draft).
  argocd_url?: string;
}

export interface Application {
  name: string;
  project: string;
  cluster: string;
  sync_status: string;
  health_status: string;
  labels?: Record<string, string>;
}

// System status page (GET /api/v1/status).
export interface ComponentStatus {
  name: string; // harbor|gitlab|argocd|store|cache
  kind: "integration" | "storage";
  mode: string; // integration: fake|real; storage: backend (postgres/memory/redis)
  status: "ok" | "error";
  detail?: string;
  url?: string; // external UI link (integrations only)
}
export interface SystemStatus {
  healthy: boolean;
  components: ComponentStatus[];
}

// --- chart publications (catalog with metadata) ---

// Lifecycle of a publication view-document draft.
export type PublicationStatus = "DRAFT" | "PENDING" | "APPROVED" | "REJECTED";

// Catalog category (grouping in the catalog and left menu).
export interface Category {
  id: string; // slug
  label: string;
  sort: number;
}

// Lightweight publication projection in the /catalog response (without view-document bodies).
export interface PublicationSummary {
  id: string;
  category_id: string;
  owner_team: string;
  created_by: string;
  created_by_name: string;
  status: PublicationStatus;
  published: boolean; // has an active approved view
  has_order_view: boolean; // approved view contains views.order (order form)
  // "Blessed" chart version: the view is verified up to it - orders on a lower
  // version can be upgraded to it.
  approved_view_version?: string;
  // Chart description at approval time (catalog shows this, not the live one).
  approved_description?: string;
  // Chart icon at approval time (catalog/profile show this, not the live one).
  // Empty - the approved version has no icon.
  approved_icon_url?: string;
}

// Catalog chart: Harbor data + publication overlay (may be absent).
export interface CatalogChart extends Chart {
  publication?: PublicationSummary | null;
  // The publication references a chart that is (no longer) in Harbor.
  missing?: boolean;
}

// Chart check report by path (POST /charts/check).
export interface ChartFileCheck {
  name: string;
  required: boolean;
  found: boolean;
}
export interface ChartCheckResult {
  ok: boolean;
  error?: string;
  chart?: Chart;
  files?: ChartFileCheck[];
}

export interface CatalogResponse {
  categories: Category[];
  charts: CatalogChart[];
}

// Computed column via a join by reference: collect the keys from the element
// (segment "*" iterates the array), find rows in the `in` array where row[match]
// equals the key, take row[get]; values are deduped and joined. Example:
// a route's hostname comes from the listener it references via sectionName.
export interface ViewColumnLookup {
  keys: string;
  in: string;
  match: string;
  get: string;
}

// Table column of a list tab. Either path - the path to a field inside the
// array element ("name" or "parentRefs/0/sectionName"), or lookup - a computed
// value. label - the header (defaults to path).
export interface ViewTableColumn {
  path?: string;
  label?: string;
  lookup?: ViewColumnLookup;
}

// Dynamic enum rule: populate an element field's enum from a sibling array in
// the order's full values. at - JSON pointer inside the element to the selector
// field (numeric segment = array element); from - JSON pointer to the source
// array in values; value - the source row field name that yields the option
// value. Example: parentRefs[].sectionName is picked from this Gateway's listener names.
export interface ViewEnumRule {
  at: string;
  from: string;
  value: string;
}

// Product tab: a list table. items - JSON pointer to an array in the order's
// values; form - id of a form from views for adding/editing a single element;
// ui:table - table columns; enums - dynamic enums of the element form.
export interface ViewTab {
  id: string;
  title?: string;
  items: string;
  form: string;
  // Text of the "Add ..." item in the tab's "Actions" button (defaults to
  // "Добавить <title>").
  addLabel?: string;
  "ui:table"?: ViewTableColumn[];
  enums?: ViewEnumRule[];
}

// Chart publication view document (formerly /schemas/{chart}.ui.json, now in the
// DB, served by the backend). Three sections:
//   views   - form library (projections over values.schema.json), including the
//             mandatory "order" (order form). A view by itself is not a tab.
//   tabs    - product tabs (list tables), each referencing an array and a form.
//   actions - placement of form views in the "Actions" button (info or tab:<id>).
export interface ViewDocument {
  views?: Record<string, any>;
  tabs?: ViewTab[];
  actions?: { view: string; in: string; label?: string }[];
}

// Full publication (GET/PATCH /publications/*).
export interface ChartPublication {
  id: string;
  chart_project: string;
  chart_name: string;
  category_id: string;
  owner_team: string;
  created_by: string;
  created_by_name: string;
  status: PublicationStatus;
  // Unapproved metadata change: live category_id/owner_team change only on
  // approve, until then the proposed values live here (empty - no edits).
  draft_category_id?: string;
  draft_owner_team?: string;
  view_json?: ViewDocument | null; // draft
  approved_view_json?: ViewDocument | null; // active approved version
  // Chart version the active view is approved for (the "blessed" one):
  // if a newer one ships in Harbor - the author should update the view.
  approved_view_version?: string;
  approved_icon_url?: string;
  reviewed_by?: string;
  review_comment?: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PublicationEvent {
  id: number;
  publication_id: string;
  actor: string;
  event_type: string;
  from_status?: PublicationStatus;
  to_status?: PublicationStatus;
  payload?: Record<string, unknown>;
  created_at: string;
}

export interface PublicationDetail {
  publication: ChartPublication;
  events: PublicationEvent[] | null;
}

// View-document validation issue (path - JSON pointer inside the document).
export interface ViewIssue {
  path: string;
  message: string;
}

// A minimal JSON Schema subset we render forms from.
export interface JSONSchema {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
}

export interface CreateOrderBody {
  chart: string; // "project/name"
  version: string;
  team: string;
  service_name: string;
  display_name?: string;
  cluster?: string; // ArgoCD destination cluster
  namespace?: string; // ArgoCD destination namespace
  values: Record<string, unknown>;
  draft?: boolean; // persist as DRAFT without opening an MR
}

// Patch for an existing order. service_name/display_name/cluster/namespace are
// honoured only while the order is still a DRAFT.
export interface UpdateOrderBody {
  version?: string;
  service_name?: string;
  display_name?: string;
  cluster?: string;
  namespace?: string;
  values: Record<string, unknown>;
}

export interface FieldError {
  path: string; // JSON Pointer into the submitted values
  message: string;
}

export interface ApiError {
  error: string;
  message?: string;
  details?: FieldError[]; // per-field schema validation failures
}
