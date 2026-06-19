import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  IconArrowUpRight,
  IconBook,
  IconBox,
  IconHistory,
  IconInfoCircle,
  IconPackages,
} from "@tabler/icons-react";
import { api } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { useUser } from "../auth/UserContext";
import { Card, ErrorBox, Spinner } from "../components/ui";

// Build-metadata rows shown as stat cards, in display order.
const META: { key: "version" | "commit" | "build_date" | "go_version"; label: string }[] = [
  { key: "version", label: "Версия" },
  { key: "commit", label: "Коммит" },
  { key: "build_date", label: "Дата сборки" },
  { key: "go_version", label: "Go" },
];

export function AboutPage() {
  const { user } = useUser();
  const { data, error, loading } = useAsync(() => api.getAbout(), []);

  // User-facing portal links (not infra consoles - those live on the status page).
  // The security role has no catalog/orders, so show it only documentation.
  const platform = user?.role !== "security";
  const links = [
    { to: "/docs", label: "Документация", hint: "Гайды и справка по платформе", Icon: IconBook },
    ...(platform
      ? [
          { to: "/catalog", label: "Каталог чартов", hint: "Доступные сервисы для заказа", Icon: IconPackages },
          { to: "/requests", label: "Мои заказы", hint: "Список и статусы инстансов", Icon: IconBox },
        ]
      : []),
  ];

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <h1 className="text-xl font-semibold text-slate-900">О портале</h1>

      {loading && !data ? (
        <Spinner />
      ) : error ? (
        <ErrorBox error={error} />
      ) : data ? (
        <>
          {/* Hero */}
          <Card className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                <IconInfoCircle size={24} stroke={1.7} />
              </span>
              <div>
                <div className="text-base font-semibold text-slate-900">Console</div>
                <div className="text-sm text-slate-500">Портал самообслуживания платформы</div>
              </div>
            </div>
            <span className="shrink-0 rounded-full bg-brand-50 px-3 py-1 font-mono text-sm font-medium text-brand-700">
              {data.version}
            </span>
          </Card>

          {/* Build metadata */}
          <Section title="Сборка">
            <div className="grid grid-cols-2 gap-3">
              {META.map(({ key, label }) => {
                const value = data[key];
                if (!value) return null;
                return <Stat key={key} label={label} value={value} />;
              })}
            </div>
          </Section>

          {/* Useful links */}
          <Section title="Полезные ссылки">
            <div className="grid grid-cols-2 gap-3">
              {links.map((l) => (
                <LinkCard key={l.to} {...l} />
              ))}
            </div>
          </Section>

          {/* Changelog (placeholder) */}
          <Section title="Изменения по версиям">
            <Card className="flex items-center gap-3 text-slate-400">
              <IconHistory size={20} stroke={1.7} className="shrink-0" />
              <span className="text-sm">Журнал изменений по версиям появится здесь.</span>
            </Card>
          </Section>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 break-all font-mono text-sm text-slate-800">{value}</div>
    </Card>
  );
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
