import { IconExternalLink } from "@tabler/icons-react";
import { useEffect } from "react";
import { api } from "../api/client";
import type { ComponentStatus, ReconcilerStatus } from "../api/types";
import { useUser } from "../auth/UserContext";
import { Button, ErrorBox, Spinner } from "../components/ui";
import { useAsync } from "../hooks/useAsync";
import { safeHref } from "../lib/href";

// Status auto-refresh interval, seconds.
const REFRESH_SECONDS = 30;

// Friendly labels for each component the backend reports.
const LABELS: Record<string, string> = {
  keycloak: "Keycloak",
  harbor: "Harbor",
  gitlab: "GitLab",
  argocd: "Argo CD",
};

// Storage rows are titled by their backend name directly.
const BACKEND_LABELS: Record<string, string> = { postgres: "PostgreSQL", redis: "Redis" };

// Friendly labels for background reconcilers (the poller's loops).
const RECONCILER_LABELS: Record<string, string> = {
  provisioning: "Провижининг заказов",
  drift: "Детект дрейфа (Git)",
  import: "Импорт из Git",
  "catalog-discovery": "Автоскан каталога",
  "argocd-fake": "ArgoCD (fake)",
};

// ago renders a coarse "N units назад" from an RFC3339 timestamp.
function ago(iso?: string): string {
  if (!iso) return "ещё не выполнялся";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s} сек назад`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

export function StatusPage() {
  const { user } = useUser();
  const { data, error, loading, reload } = useAsync(() => api.getSystemStatus(), []);

  // Auto-refresh: status is live, keep the page fresh without manual reload.
  useEffect(() => {
    const t = setInterval(reload, REFRESH_SECONDS * 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // System status is a platform-admin tool (the topbar link is hidden for others;
  // this guards a direct URL visit too).
  if (user?.role !== "admin") {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        Раздел доступен только администраторам платформы.
      </div>
    );
  }

  const integrations = (data?.components ?? []).filter((c) => c.kind === "integration");
  const storage = (data?.components ?? []).filter((c) => c.kind === "storage");

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-slate-900">Статус системы</h1>
          {data &&
            (data.healthy ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                <Dot ok /> Всё работает
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700">
                <Dot /> Есть проблемы
              </span>
            ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">автообновление каждые {REFRESH_SECONDS} сек</span>
          {safeHref(data?.grafana_url) && (
            <a
              href={safeHref(data?.grafana_url)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-surface px-3 py-1.5 text-sm font-medium text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Grafana
              <IconExternalLink size={14} stroke={1.8} />
            </a>
          )}
          <Button variant="secondary" onPress={reload} isDisabled={loading}>
            {loading ? "Обновление…" : "Обновить"}
          </Button>
        </div>
      </div>

      {loading && !data ? (
        <Spinner />
      ) : error ? (
        <ErrorBox error={error} />
      ) : (
        <>
          <Section title="Интеграции" items={integrations} />
          <Section title="Хранилища" items={storage} />
          <ReconcilerSection items={data?.reconcilers ?? []} />
        </>
      )}
    </div>
  );
}

function ReconcilerSection({ items }: { items: ReconcilerStatus[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Фоновые циклы</h2>
        <span className="text-xs text-slate-400">подробности и графики - в Grafana</span>
      </div>
      <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-surface shadow-sm">
        {items.map((r) => {
          const ok = r.status === "ok";
          return (
            <div key={r.name} className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Dot ok={ok} />
                  <span className="font-medium text-slate-800">{RECONCILER_LABELS[r.name] ?? r.name}</span>
                </div>
                <p className="mt-0.5 pl-5 text-xs text-slate-500">последний успех: {ago(r.last_success)}</p>
                {!ok && r.last_error && (
                  <p className="mt-1 break-words pl-5 text-xs text-red-600">{r.last_error}</p>
                )}
              </div>
              <span className={`shrink-0 text-sm font-medium ${ok ? "text-emerald-600" : "text-red-600"}`}>
                {ok ? "OK" : "Сбой"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Section({ title, items }: { title: string; items: ComponentStatus[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-surface shadow-sm">
        {items.map((c) => (
          <Row key={c.name} c={c} />
        ))}
      </div>
    </div>
  );
}

function Row({ c }: { c: ComponentStatus }) {
  const ok = c.status === "ok";
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Dot ok={ok} />
          <span className="font-medium text-slate-800">
            {c.kind === "storage" ? (BACKEND_LABELS[c.mode] ?? c.mode) : (LABELS[c.name] ?? c.name)}
          </span>
        </div>
        {safeHref(c.url) && (
          <a
            href={safeHref(c.url)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 inline-flex items-center gap-1 pl-5 text-xs text-brand-600 hover:text-brand-700 hover:underline"
          >
            {c.url}
            <IconExternalLink size={12} stroke={1.8} />
          </a>
        )}
        {!ok && c.detail && (
          <p className="mt-1 break-words pl-5 text-xs text-red-600">{c.detail}</p>
        )}
      </div>
      <span className={`shrink-0 text-sm font-medium ${ok ? "text-emerald-600" : "text-red-600"}`}>
        {ok ? "OK" : "Ошибка"}
      </span>
    </div>
  );
}

function Dot({ ok = false }: { ok?: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${ok ? "bg-emerald-500" : "bg-red-500"}`}
    />
  );
}
