import {
  IconActivity,
  IconArrowRight,
  IconChecklist,
  IconCircleCheck,
  IconClock,
  IconFileText,
  IconPackage,
  IconPlus,
  IconSettings,
  IconStack,
  IconTags,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { api, HttpError } from "../api/client";
import type { Category, ChartPublication, PublicationStatus } from "../api/types";
import { chartLabel, useCatalog } from "../app/CatalogContext";
import { useUser } from "../auth/UserContext";
import { Button, ErrorBox, Spinner, TextField } from "../components/ui";
import { useAsync } from "../hooks/useAsync";

// ---------------------------------------------------------------------------
// shared visual bits (same language as the security section)
// ---------------------------------------------------------------------------

const TONE = {
  emerald: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-red-700",
  slate: "bg-slate-100 text-slate-600",
  brand: "bg-brand-50 text-brand-700",
} as const;
type Tone = keyof typeof TONE;

const STATUS_META: Record<PublicationStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: "Черновик", tone: "slate" },
  PENDING: { label: "На согласовании", tone: "amber" },
  APPROVED: { label: "Согласовано", tone: "emerald" },
  REJECTED: { label: "Отклонено", tone: "red" },
};

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${TONE[tone]}`}>
      {children}
    </span>
  );
}

function StatCard({
  label,
  value,
  tone,
  Icon,
}: {
  label: string;
  value: ReactNode;
  tone: Tone;
  Icon: typeof IconClock;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-surface p-4 shadow-sm">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${TONE[tone]}`}>
        <Icon size={20} stroke={1.8} />
      </span>
      <div className="min-w-0">
        <div className="text-2xl font-semibold leading-tight text-slate-900">{value}</div>
        <div className="truncate text-xs text-slate-500">{label}</div>
      </div>
    </div>
  );
}

function PageTitle({ title, badge }: { title: string; badge?: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
      {badge}
    </div>
  );
}

const managePath = (p: Pick<ChartPublication, "chart_project" | "chart_name">) =>
  `/catalog/${p.chart_project}/${p.chart_name}/manage`;

// ---------------------------------------------------------------------------
// section guard
// ---------------------------------------------------------------------------

// AdminSection guards the platform-admin area and renders the active sub-page.
// Mirrors SecuritySection: a thin role gate around <Outlet/>; the sidebar drives
// navigation between the section's pages.
export function AdminSection() {
  const { user } = useUser();
  if (user?.role !== "admin") {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        Раздел доступен только администраторам платформы.
      </div>
    );
  }
  return <Outlet />;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export function AdminOverviewPage() {
  const { data: pubs, error, loading } = useAsync(() => api.listPublications(), []);
  if (loading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;

  const all = pubs ?? [];
  const pending = all.filter((p) => p.status === "PENDING");
  const published = all.filter((p) => !!p.approved_view_json).length;
  const drafts = all.filter((p) => p.status === "DRAFT" || p.status === "REJECTED").length;

  return (
    <div className="flex flex-col gap-6">
      <PageTitle
        title="Администрирование платформы"
        badge={
          <Badge tone="brand">
            <IconSettings size={13} stroke={1.8} /> Admin
          </Badge>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Ждут согласования" value={pending.length} tone="amber" Icon={IconClock} />
        <StatCard label="Опубликовано" value={published} tone="emerald" Icon={IconCircleCheck} />
        <StatCard label="Черновики" value={drafts} tone="slate" Icon={IconFileText} />
        <StatCard label="Всего публикаций" value={all.length} tone="brand" Icon={IconStack} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* approval queue preview */}
        <div className="rounded-lg border border-slate-200 bg-surface p-4 shadow-sm lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-800">Очередь на согласование</h2>
            {pending.length > 0 && (
              <Link to="/admin/approvals" className="text-xs font-medium text-brand-600 hover:text-brand-700">
                Все
              </Link>
            )}
          </div>
          {pending.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                <IconCircleCheck size={22} stroke={1.8} />
              </span>
              <p className="text-sm text-slate-500">Нет публикаций, ожидающих решения.</p>
            </div>
          ) : (
            <ul className="-mx-2 flex flex-col">
              {pending.map((p) => (
                <li key={p.id}>
                  <Link
                    to={managePath(p)}
                    className="group flex items-center justify-between gap-3 rounded-md px-2 py-2.5 hover:bg-slate-50"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
                        <IconPackage size={16} stroke={1.8} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-slate-800">
                          {chartLabel(p.chart_name)}
                        </span>
                        <span className="block truncate text-xs text-slate-400">
                          {p.chart_project}/{p.chart_name}
                        </span>
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <Badge tone="brand">{p.owner_team}</Badge>
                      <IconArrowRight size={16} className="text-slate-300 group-hover:text-brand-500" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* quick links */}
        <div className="flex flex-col gap-4">
          <QuickLink
            to="/admin/approvals"
            tone="amber"
            Icon={IconChecklist}
            title="Согласование публикаций"
            desc={pending.length > 0 ? `${pending.length} в очереди` : "очередь пуста"}
          />
          <QuickLink
            to="/admin/status"
            tone="brand"
            Icon={IconActivity}
            title="Состояние платформы"
            desc="интеграции, хранилища, циклы"
          />
          <QuickLink
            to="/admin/categories"
            tone="slate"
            Icon={IconTags}
            title="Категории каталога"
            desc="структура разделов каталога"
          />
        </div>
      </div>
    </div>
  );
}

function QuickLink({
  to,
  tone,
  Icon,
  title,
  desc,
}: {
  to: string;
  tone: Tone;
  Icon: typeof IconClock;
  title: string;
  desc: string;
}) {
  return (
    <Link
      to={to}
      className="group flex items-center justify-between rounded-lg border border-slate-200 bg-surface p-4 shadow-sm outline-none hover:border-brand-300 hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <span className="flex items-center gap-3">
        <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${TONE[tone]}`}>
          <Icon size={18} stroke={1.8} />
        </span>
        <span>
          <span className="block text-sm font-medium text-slate-800">{title}</span>
          <span className="block text-xs text-slate-500">{desc}</span>
        </span>
      </span>
      <IconArrowRight size={18} className="text-slate-300 group-hover:text-brand-500" />
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Approvals queue
// ---------------------------------------------------------------------------

type Filter = "ALL" | PublicationStatus;

export function AdminApprovalsPage() {
  const { data: pubs, error, loading } = useAsync(() => api.listPublications(), []);
  const [filter, setFilter] = useState<Filter>("ALL");

  if (loading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;

  const all = pubs ?? [];
  const count = (s: Filter) => (s === "ALL" ? all.length : all.filter((p) => p.status === s).length);
  const rows = filter === "ALL" ? all : all.filter((p) => p.status === filter);
  const filters: { id: Filter; label: string }[] = [
    { id: "ALL", label: "Все" },
    { id: "PENDING", label: "Ожидают" },
    { id: "APPROVED", label: "Согласованные" },
    { id: "REJECTED", label: "Отклонённые" },
    { id: "DRAFT", label: "Черновики" },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        title="Согласование публикаций"
        badge={<Badge tone="amber">{count("PENDING")} в очереди</Badge>}
      />

      <div className="flex flex-wrap gap-2">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
              filter === f.id
                ? "border-brand-200 bg-brand-50 text-brand-700"
                : "border-slate-200 bg-surface text-slate-600 hover:bg-slate-50"
            }`}
          >
            {f.label}
            <span className="rounded-full bg-black/5 px-1.5 text-[11px] text-slate-500">{count(f.id)}</span>
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-slate-200 bg-surface py-12 text-center shadow-sm">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
            <IconChecklist size={22} stroke={1.8} />
          </span>
          <p className="text-sm text-slate-500">Публикаций в этой категории нет.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-surface shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-2.5 font-medium">Чарт</th>
                <th className="px-4 py-2.5 font-medium">Команда</th>
                <th className="px-4 py-2.5 font-medium">Статус</th>
                <th className="px-4 py-2.5 text-right font-medium">Действия</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const st = STATUS_META[p.status];
                const isPending = p.status === "PENDING";
                return (
                  <tr key={p.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                          <IconPackage size={16} stroke={1.8} />
                        </span>
                        <span className="min-w-0">
                          <span className="block font-medium text-slate-800">{chartLabel(p.chart_name)}</span>
                          <span className="block truncate text-xs text-slate-400">
                            {p.chart_project}/{p.chart_name}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{p.owner_team}</td>
                    <td className="px-4 py-3">
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <Link
                          to={managePath(p)}
                          className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium outline-none focus-visible:ring-2 ${
                            isPending
                              ? "border-brand-200 bg-brand-50 text-brand-700 hover:bg-brand-100 focus-visible:ring-brand-500"
                              : "border-slate-200 bg-surface text-slate-600 hover:bg-slate-50 focus-visible:ring-brand-500"
                          }`}
                        >
                          {isPending ? "Рассмотреть" : "Открыть"}
                          <IconArrowRight size={14} stroke={1.8} />
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export function AdminCategoriesPage() {
  const { categories, reload } = useCatalog();
  const [draft, setDraft] = useState<Category>({ id: "", label: "", sort: 0 });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setErr(e instanceof HttpError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        title="Категории каталога"
        badge={<Badge tone="slate">{categories.length}</Badge>}
      />

      {err && <ErrorBox error={new Error(err)} />}

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-surface shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2.5 font-medium">ID (slug)</th>
              <th className="px-4 py-2.5 font-medium">Название</th>
              <th className="w-28 px-4 py-2.5 font-medium">Порядок</th>
              <th className="px-4 py-2.5 text-right font-medium">Действия</th>
            </tr>
          </thead>
          <tbody>
            {categories.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-slate-500">
                  Категорий нет. Добавьте первую ниже.
                </td>
              </tr>
            ) : (
              categories.map((c) => <CategoryRow key={c.id} category={c} busy={busy} run={run} />)
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-slate-200 bg-surface p-4 shadow-sm">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-800">
          <IconPlus size={16} stroke={1.8} className="text-slate-400" />
          Добавить категорию
        </h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-40">
            <TextField label="ID (slug)" value={draft.id} onChange={(v) => setDraft({ ...draft, id: v })} />
          </div>
          <div className="min-w-48 flex-1">
            <TextField label="Название" value={draft.label} onChange={(v) => setDraft({ ...draft, label: v })} />
          </div>
          <div className="w-28">
            <TextField
              label="Порядок"
              value={String(draft.sort)}
              onChange={(v) => setDraft({ ...draft, sort: Number(v) || 0 })}
            />
          </div>
          <Button
            variant="primary"
            isDisabled={busy || !draft.id.trim() || !draft.label.trim()}
            onPress={() =>
              run(() => api.createCategory({ ...draft, id: draft.id.trim(), label: draft.label.trim() })).then(() =>
                setDraft({ id: "", label: "", sort: 0 }),
              )
            }
          >
            <IconPlus size={16} stroke={1.8} /> Добавить
          </Button>
        </div>
      </div>
    </div>
  );
}

function CategoryRow({
  category,
  busy,
  run,
}: {
  category: Category;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [label, setLabel] = useState(category.label);
  const [sort, setSort] = useState(String(category.sort));
  const dirty = label !== category.label || Number(sort) !== category.sort;
  return (
    <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-slate-500">{category.id}</span>
      </td>
      <td className="px-4 py-3">
        <TextField label="Название" hideLabel value={label} onChange={setLabel} />
      </td>
      <td className="px-4 py-3">
        <TextField label="Порядок" hideLabel value={sort} onChange={setSort} />
      </td>
      <td className="px-4 py-3">
        <div className="flex justify-end gap-2">
          <Button
            isDisabled={busy || !dirty || !label.trim()}
            onPress={() =>
              run(() => api.updateCategory({ id: category.id, label: label.trim(), sort: Number(sort) || 0 }))
            }
          >
            Сохранить
          </Button>
          <Button variant="danger" isDisabled={busy} onPress={() => run(() => api.deleteCategory(category.id))}>
            Удалить
          </Button>
        </div>
      </td>
    </tr>
  );
}
