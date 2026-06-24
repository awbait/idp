import type {
  AboutInfo,
  ApiError,
  Application,
  CatalogResponse,
  Category,
  ChangelogEntry,
  ChangelogRelease,
  Chart,
  ChartCheckResult,
  ChartPublication,
  ChartVersion,
  CreateOrderBody,
  FieldError,
  JSONSchema,
  OrderRequest,
  PublicationDetail,
  RequestDetail,
  SystemStatus,
  UpdateOrderBody,
  User,
  ViewDocument,
  ViewIssue,
} from "./types";

const BASE = "/api/v1";

// Default network timeout. A hung backend/proxy must not leave a request (and its
// spinner) pending forever; after this the fetch is aborted and surfaced as an error.
const REQUEST_TIMEOUT_MS = 30_000;

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

// Friendly message for any thrown value: HttpError/Error carry their own message,
// anything else is stringified. Used by callers to surface failures (e.g. toasts).
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

// Central 401 handler, registered by the auth layer. Lets a mid-session
// expiry trigger a re-login flow (return-to current page) instead of surfacing
// a raw "unauthorized" error in every caller. Kept out of React so the plain
// fetch wrapper stays dependency-free.
let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(h: (() => void) | null) {
  unauthorizedHandler = h;
}

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  // Combine the default timeout with the caller's signal (useAsync aborts on
  // unmount/deps change), so either source can cancel the in-flight fetch.
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: "include",
      headers: {
        ...devHeaders(),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: combined,
    });
  } catch (e) {
    // The timeout aborts with a TimeoutError; surface it as a clear message
    // instead of a bare DOMException. A caller-initiated abort keeps its
    // AbortError name so useAsync recognises and ignores it.
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new Error("Превышено время ожидания ответа сервера");
    }
    throw e;
  }
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
  // Browser-navigated GET: clears the session and bounces through the IdP's
  // end-session endpoint, so it must be a full navigation, not a fetch.
  logoutUrl: () => `${BASE}/auth/logout`,

  // catalog
  listCharts: () => req<Chart[]>("GET", "/charts"),
  // Catalog in one request: Harbor charts + categories + publication overlay.
  getCatalog: () => req<CatalogResponse>("GET", "/catalog"),
  // Check a chart by arbitrary Harbor path (project/name) before publishing.
  checkChart: (path: string) => req<ChartCheckResult>("POST", "/charts/check", { path }),
  getChart: (project: string, name: string, signal?: AbortSignal) =>
    req<Chart>("GET", `/charts/${enc(project)}/${enc(name)}`, undefined, signal),
  getVersion: (project: string, name: string, version: string, signal?: AbortSignal) =>
    req<ChartVersion>("GET", `/charts/${enc(project)}/${enc(name)}/${enc(version)}`, undefined, signal),
  getValues: (project: string, name: string, version: string, signal?: AbortSignal) =>
    req<string>("GET", `/charts/${enc(project)}/${enc(name)}/${enc(version)}/values`, undefined, signal),
  getReadme: (project: string, name: string, version: string, signal?: AbortSignal) =>
    req<string>("GET", `/charts/${enc(project)}/${enc(name)}/${enc(version)}/readme`, undefined, signal),
  getSchema: (project: string, name: string, version: string, signal?: AbortSignal) =>
    req<JSONSchema>("GET", `/charts/${enc(project)}/${enc(name)}/${enc(version)}/schema`, undefined, signal),
  getAggregatedChangelog: (project: string, name: string, limit = 20, signal?: AbortSignal) =>
    req<ChangelogEntry[]>(
      "GET",
      `/charts/${enc(project)}/${enc(name)}/changelog/aggregated?limit=${limit}`,
      undefined,
      signal,
    ),
  // Active approved chart view (view document from the publication). null -
  // the chart has no approved view (form-based ordering is unavailable).
  getChartView: (project: string, name: string, signal?: AbortSignal) =>
    req<ViewDocument>("GET", `/charts/${enc(project)}/${enc(name)}/view`, undefined, signal).catch((e) => {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }),

  // catalog categories (CRUD - admin)
  listCategories: () => req<Category[]>("GET", "/categories"),
  createCategory: (c: Category) => req<Category>("POST", "/categories", c),
  updateCategory: (c: Category) =>
    req<Category>("PATCH", `/categories/${enc(c.id)}`, { label: c.label, sort: c.sort, icon: c.icon }),
  deleteCategory: (id: string) => req<void>("DELETE", `/categories/${enc(id)}`),

  // chart publications (metadata + view builder + approval)
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
  getRequest: (id: string, signal?: AbortSignal) =>
    req<RequestDetail>("GET", `/requests/${enc(id)}`, undefined, signal),
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

  // about: portal version + changelog
  getAbout: () => req<AboutInfo>("GET", "/info"),
  getChangelog: () => req<ChangelogRelease[]>("GET", "/changelog"),
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
