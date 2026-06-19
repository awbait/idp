import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  IconArrowUpRight,
  IconBook,
  IconBox,
  IconInfoCircle,
  IconPackages,
} from "@tabler/icons-react";
import { api } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { useUser } from "../auth/UserContext";
import { Card, ErrorBox, Spinner } from "../components/ui";

// Markdown styling for changelog bodies (subheadings + bullets + inline code).
const MD: Components = {
  h3: ({ children }) => (
    <div className="mt-3 mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
      {children}
    </div>
  ),
  ul: ({ children }) => <ul className="ml-4 list-disc space-y-1">{children}</ul>,
  li: ({ children }) => <li className="text-sm text-slate-700 marker:text-slate-300">{children}</li>,
  p: ({ children }) => <p className="text-sm text-slate-700">{children}</p>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs text-slate-800">
      {children}
    </code>
  ),
  strong: ({ children }) => <strong className="font-semibold text-slate-800">{children}</strong>,
};

export function AboutPage() {
  const { user } = useUser();
  const about = useAsync(() => api.getAbout(), []);
  const changelog = useAsync(() => api.getChangelog(), []);

  // User-facing portal links (not infra consoles - those live on the status page).
  // The security role has no catalog/orders, so it only gets documentation.
  const platform = user?.role !== "security";
  const links = [
    { to: "/docs", label: "Документация", hint: "Гайды и справка", Icon: IconBook },
    ...(platform
      ? [
          { to: "/catalog", label: "Каталог чартов", hint: "Сервисы для заказа", Icon: IconPackages },
          { to: "/requests", label: "Мои заказы", hint: "Инстансы и статусы", Icon: IconBox },
        ]
      : []),
  ];

  const info = about.data;
  const hasBuild = info && (info.commit || info.build_date);

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <h1 className="text-xl font-semibold text-slate-900">О портале</h1>

      {about.loading && !info ? (
        <Spinner />
      ) : about.error ? (
        <ErrorBox error={about.error} />
      ) : info ? (
        <>
          {/* Hero */}
          <Card className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                <IconInfoCircle size={24} stroke={1.7} />
              </span>
              <div>
                <div className="text-base font-semibold text-slate-900">Console</div>
                <div className="text-sm text-slate-500">Заказ и управление сервисами платформы</div>
              </div>
            </div>
            <span className="shrink-0 rounded-full bg-brand-50 px-3 py-1 font-mono text-sm font-medium text-brand-700">
              {info.version}
            </span>
          </Card>

          <div className="grid gap-6 lg:grid-cols-3">
            {/* Main column: changelog */}
            <div className="lg:col-span-2">
              <Section title="Журнал изменений">
                {changelog.loading && !changelog.data ? (
                  <Spinner />
                ) : changelog.error ? (
                  <ErrorBox error={changelog.error} />
                ) : changelog.data && changelog.data.length > 0 ? (
                  <div className="flex flex-col gap-3">
                    {changelog.data.map((r) => (
                      <Card key={r.version}>
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-mono text-sm font-semibold text-slate-900">
                            {r.version}
                          </span>
                          {r.date && <span className="text-xs text-slate-400">{r.date}</span>}
                        </div>
                        <div className="mt-2">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>
                            {r.body}
                          </ReactMarkdown>
                        </div>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <Card className="text-sm text-slate-400">Пока нет записей.</Card>
                )}
              </Section>
            </div>

            {/* Sidebar: build info + links */}
            <div className="flex flex-col gap-6">
              {hasBuild && (
                <Section title="Сборка">
                  <Card className="flex flex-col gap-2">
                    {info.commit && <Row label="Коммит" value={info.commit} mono />}
                    {info.build_date && <Row label="Дата сборки" value={fmtDate(info.build_date)} />}
                  </Card>
                </Section>
              )}

              <Section title="Полезные ссылки">
                <div className="flex flex-col gap-3">
                  {links.map((l) => (
                    <LinkCard key={l.to} {...l} />
                  ))}
                </div>
              </Section>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      {children}
    </div>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-slate-500">{label}</span>
      <span className={`break-all text-sm text-slate-800 ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

// fmtDate renders an RFC3339 build timestamp in the local, human-readable form;
// falls back to the raw value if it does not parse.
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function LinkCard({
  to,
  label,
  hint,
  Icon,
}: {
  to: string;
  label: string;
  hint: string;
  Icon: typeof IconBook;
}) {
  return (
    <Link
      to={to}
      className="group flex items-start gap-3 rounded-lg border border-gray-200 bg-surface p-4 shadow-sm outline-none transition hover:border-brand-300 hover:shadow focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-50 text-slate-500 group-hover:bg-brand-50 group-hover:text-brand-600">
        <Icon size={20} stroke={1.7} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 font-medium text-slate-800">
          {label}
          <IconArrowUpRight
            size={14}
            stroke={1.8}
            className="text-slate-300 group-hover:text-brand-500"
          />
        </div>
        <div className="mt-0.5 text-xs text-slate-500">{hint}</div>
      </div>
    </Link>
  );
}
