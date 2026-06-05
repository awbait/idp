// Mirrors the Go backend domain models (pkg/models).

export type Role = "viewer" | "member" | "admin";

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

// --- публикации чартов (каталог с метаданными) ---

// Жизненный цикл черновика view-документа публикации.
export type PublicationStatus = "DRAFT" | "PENDING" | "APPROVED" | "REJECTED";

// Категория каталога (группировка в каталоге и левом меню).
export interface Category {
  id: string; // slug
  label: string;
  sort: number;
}

// Лёгкая проекция публикации в ответе /catalog (без тел view-документов).
export interface PublicationSummary {
  id: string;
  category_id: string;
  owner_team: string;
  created_by: string;
  created_by_name: string;
  status: PublicationStatus;
  published: boolean; // есть действующая approved-view
  has_order_view: boolean; // approved-view содержит views.order (форма заказа)
}

// Чарт каталога: Harbor-данные + оверлей публикации (может отсутствовать).
export interface CatalogChart extends Chart {
  publication?: PublicationSummary | null;
  // Публикация ссылается на чарт, которого (уже) нет в Harbor.
  missing?: boolean;
}

// Отчёт проверки чарта по пути (POST /charts/check).
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

// View-документ публикации чарта (бывший /schemas/{chart}.ui.json, теперь в БД,
// отдаётся бэкендом). views.* — презентационные проекции поверх values.schema.json
// (order/routes/listeners/resources, см. SchemaForm.View).
export interface ViewDocument {
  views?: Record<string, any>;
}

// Полная публикация (GET/PATCH /publications/*).
export interface ChartPublication {
  id: string;
  chart_project: string;
  chart_name: string;
  category_id: string;
  owner_team: string;
  created_by: string;
  created_by_name: string;
  status: PublicationStatus;
  view_json?: ViewDocument | null; // черновик
  approved_view_json?: ViewDocument | null; // активная согласованная версия
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

// Проблема валидации view-документа (path — JSON pointer внутри документа).
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
