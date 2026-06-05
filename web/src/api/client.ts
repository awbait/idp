import type {
  Application,
  ApiError,
  CatalogResponse,
  Chart,
  FieldError,
  ChartVersion,
  ChangelogEntry,
  CreateOrderBody,
  JSONSchema,
  OrderRequest,
  RequestDetail,
  UpdateOrderBody,
  User,
  SystemStatus,
  ViewDocument,
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
  loginUrl: () => BASE + "/auth/login",
  logout: () => req<void>("POST", "/auth/logout"),

  // catalog
  listCharts: () => req<Chart[]>("GET", "/charts"),
  // Каталог одним запросом: Harbor-чарты + категории + оверлей публикаций.
  getCatalog: () => req<CatalogResponse>("GET", "/catalog"),
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
