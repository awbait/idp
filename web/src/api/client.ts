import type {
  Application,
  ApiError,
  CatalogResponse,
  Category,
  Chart,
  ChartCheckResult,
  ChartPublication,
  FieldError,
  ChartVersion,
  ChangelogEntry,
  CreateOrderBody,
  JSONSchema,
  OrderRequest,
  PublicationDetail,
  RequestDetail,
  UpdateOrderBody,
  User,
  SystemStatus,
  ViewDocument,
  ViewIssue,
} from "./types";

const BASE = "/api/v1";

// In dev (AUTH_MODE=dev backend) we impersonate a user via headers. In OIDC
// mode these are ignored and the session cookie is used.
function devHeaders(): Record<string, string> {
  if (import.meta.env.VITE_DEV_AUTH !== "true") return {};
  const h: Record<string, string> = {};
  if (import.meta.env.VITE_DEV_TEAMS) h["X-Dev-Teams"] = import.meta.env.VITE_DEV_TEAMS;
  if (import.meta.env.VITE_DEV_ROLE) h["X-Dev-Role"] = import.meta.env.VITE_DEV_ROLE;
  return h;
}

export class HttpError extends Error {
  status: number;
  code: string;
  details: FieldError[];
  constructor(status: number, body: ApiError | null) {
    super(body?.message || body?.error || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error ?? "error";
    this.details = body?.details ?? [];
  }
}

// Central 401 handler, registered by the auth layer. Lets a mid-session
// expiry trigger a re-login flow (return-to current page) instead of surfacing
// a raw "unauthorized" error in every caller. Kept out of React so the plain
// fetch wrapper stays dependency-free.
let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(h: (() => void) | null) {
  unauthorizedHandler = h;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    credentials: "include",
    headers: {
      ...devHeaders(),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let parsed: ApiError | null = null;
    try {
      parsed = await res.json();
    } catch {
      /* non-JSON error */
    }
    if (res.status === 401) unauthorizedHandler?.();
    throw new HttpError(res.status, parsed);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export const api = {
  // auth
  me: () => req<User>("GET", "/auth/me"),
  loginUrl: (returnTo?: string) =>
    returnTo
      ? `${BASE}/auth/login?return_to=${encodeURIComponent(returnTo)}`
      : `${BASE}/auth/login`,
  logout: () => req<void>("POST", "/auth/logout"),

  // catalog
  listCharts: () => req<Chart[]>("GET", "/charts"),
  // Каталог одним запросом: Harbor-чарты + категории + оверлей публикаций.
  getCatalog: () => req<CatalogResponse>("GET", "/catalog"),
  // Проверка чарта по произвольному пути в Harbor (project/name) перед публикацией.
  checkChart: (path: string) => req<ChartCheckResult>("POST", "/charts/check", { path }),
  getChart: (project: string, name: string) =>
    req<Chart>("GET", `/charts/${enc(project)}/${enc(name)}`),
  getVersion: (project: string, name: string, version: string) =>
    req<ChartVersion>("GET", `/charts/${enc(project)}/${enc(name)}/${enc(version)}`),
  getValues: (project: string, name: string, version: string) =>
    req<string>("GET", `/charts/${enc(project)}/${enc(name)}/${enc(version)}/values`),
  getReadme: (project: string, name: string, version: string) =>
    req<string>("GET", `/charts/${enc(project)}/${enc(name)}/${enc(version)}/readme`),
  getSchema: (project: string, name: string, version: string) =>
    req<JSONSchema>("GET", `/charts/${enc(project)}/${enc(name)}/${enc(version)}/schema`),
  getAggregatedChangelog: (project: string, name: string, limit = 20) =>
    req<ChangelogEntry[]>(
      "GET",
      `/charts/${enc(project)}/${enc(name)}/changelog/aggregated?limit=${limit}`,
    ),
  // Активная согласованная view чарта (view-документ из публикации). null —
  // у чарта нет approved-view (заказ через форму недоступен).
  getChartView: (project: string, name: string) =>
    req<ViewDocument>("GET", `/charts/${enc(project)}/${enc(name)}/view`).catch((e) => {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }),

  // категории каталога (CRUD — admin)
  listCategories: () => req<Category[]>("GET", "/categories"),
  createCategory: (c: Category) => req<Category>("POST", "/categories", c),
  updateCategory: (c: Category) =>
    req<Category>("PATCH", `/categories/${enc(c.id)}`, { label: c.label, sort: c.sort }),
  deleteCategory: (id: string) => req<void>("DELETE", `/categories/${enc(id)}`),

  // публикации чартов (метаданные + view-конструктор + согласование)
  listPublications: (params?: Record<string, string>) =>
    req<ChartPublication[] | null>("GET", "/publications" + qs(params)).then((r) => r ?? []),
  createPublication: (body: { chart: string; category_id: string; owner_team: string }) =>
    req<ChartPublication>("POST", "/publications", body),
  getPublication: (id: string) => req<PublicationDetail>("GET", `/publications/${enc(id)}`),
  updatePublication: (
    id: string,
    body: { category_id?: string; owner_team?: string; view?: ViewDocument },
  ) => req<ChartPublication>("PATCH", `/publications/${enc(id)}`, body),
  validatePublication: (id: string, view: ViewDocument) =>
    req<{ issues: ViewIssue[] }>("POST", `/publications/${enc(id)}/validate`, { view }),
  submitPublication: (id: string) => req<ChartPublication>("POST", `/publications/${enc(id)}/submit`),
  withdrawPublication: (id: string) =>
    req<ChartPublication>("POST", `/publications/${enc(id)}/withdraw`),
  approvePublication: (id: string) =>
    req<ChartPublication>("POST", `/publications/${enc(id)}/approve`),
  rejectPublication: (id: string, comment: string) =>
    req<ChartPublication>("POST", `/publications/${enc(id)}/reject`, { comment }),

  // requests
  listRequests: (params?: Record<string, string>) =>
    req<OrderRequest[]>("GET", "/requests" + qs(params)),
  getRequest: (id: string) => req<RequestDetail>("GET", `/requests/${enc(id)}`),
  createRequest: (body: CreateOrderBody) => req<OrderRequest>("POST", "/requests", body),
  updateRequest: (id: string, body: UpdateOrderBody) =>
    req<OrderRequest>("PATCH", `/requests/${enc(id)}`, body),
  renameRequest: (id: string, display_name: string) =>
    req<OrderRequest>("POST", `/requests/${enc(id)}/rename`, { display_name }),
  submitRequest: (id: string) => req<OrderRequest>("POST", `/requests/${enc(id)}/submit`),
  deleteRequest: (id: string) => req<OrderRequest>("DELETE", `/requests/${enc(id)}`),
  syncRequest: (id: string) => req<unknown>("POST", `/requests/${enc(id)}/sync`),
  // Adopt the order's current Git state (values + version) into the portal.
  pullRequest: (id: string) => req<OrderRequest>("POST", `/requests/${enc(id)}/pull`),

  // applications
  listApplications: () => req<Application[]>("GET", "/applications"),

  // system status (integrations + storage health)
  getSystemStatus: () => req<SystemStatus>("GET", "/status"),
};

function enc(s: string) {
  return encodeURIComponent(s);
}
function qs(params?: Record<string, string>) {
  if (!params) return "";
  const entries = Object.entries(params).filter(([, v]) => v !== "");
  if (entries.length === 0) return "";
  return "?" + new URLSearchParams(Object.fromEntries(entries)).toString();
}
