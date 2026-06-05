import { IconExternalLink } from "@tabler/icons-react";
import { api } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { Button, ErrorBox, Spinner } from "../components/ui";
import type { ComponentStatus } from "../api/types";

// Friendly labels for each component the backend reports.
const LABELS: Record<string, string> = {
  keycloak: "Keycloak",
  harbor: "Harbor",
  gitlab: "GitLab",
  argocd: "Argo CD",
};

// Storage rows are titled by their backend name directly.
const BACKEND_LABELS: Record<string, string> = { postgres: "postgresql" };

export function StatusPage() {
  const { data, error, loading, reload } = useAsync(() => api.getSystemStatus(), []);

  const integrations = (data?.components ?? []).filter((c) => c.kind === "integration");
  const storage = (data?.components ?? []).filter((c) => c.kind === "storage");

  return (
    <div className="flex flex-col gap-5">
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
        <Button variant="secondary" onPress={reload} isDisabled={loading}>
          {loading ? "Обновление…" : "Обновить"}
        </Button>
      </div>

      {loading && !data ? (
        <Spinner />
      ) : error ? (
        <ErrorBox error={error} />
      ) : (
        <>
          <Section title="Интеграции" items={integrations} />
          <Section title="Хранилища" items={storage} />
        </>
      )}
    </div>
  );
}

function Section({ title, items }: { title: string; items: ComponentStatus[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
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
        {c.url && (
          <a
            href={c.url}
            target="_blank"
            rel="noreferrer"
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
