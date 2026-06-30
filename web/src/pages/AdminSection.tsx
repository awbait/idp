import {
  IconActivity,
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconChecklist,
  IconCircleCheck,
  IconClock,
  IconFileText,
  IconGripVertical,
  IconLock,
  IconPackage,
  IconPencil,
  IconPlus,
  IconSettings,
  IconStack,
  IconTags,
  IconTrash,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button as AriaButton,
  Dialog,
  DialogTrigger,
  Heading,
  Modal,
  ModalOverlay,
  Popover,
} from "react-aria-components";
import { Link, Outlet, useParams } from "react-router-dom";
import { api, HttpError } from "../api/client";
import type { Category, ChartPublication, PublicationStatus } from "../api/types";
import { chartLabel, useCatalog } from "../app/CatalogContext";
import { useUser } from "../auth/UserContext";
import { CATEGORY_ICON_CHOICES, categoryIcon } from "../components/icons";
import { PublicationReview, VersionReview } from "../components/PublicationReview";
import { Button, ErrorBox, Spinner } from "../components/ui";
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
const reviewPath = (p: Pick<ChartPublication, "chart_project" | "chart_name">) =>
  `/admin/approvals/${p.chart_project}/${p.chart_name}`;

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
  const { data: pendingVers } = useAsync(() => api.pendingVersions(), []);
  if (loading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;

  const all = pubs ?? [];
  const pendingMeta = all.filter((p) => p.status === "PENDING");
  const pendingVersions = pendingVers ?? [];
  const pendingCount = pendingMeta.length + pendingVersions.length;
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
        <StatCard label="Ждут согласования" value={pendingCount} tone="amber" Icon={IconClock} />
        <StatCard label="Опубликовано" value={published} tone="emerald" Icon={IconCircleCheck} />
        <StatCard label="Черновики" value={drafts} tone="slate" Icon={IconFileText} />
        <StatCard label="Всего публикаций" value={all.length} tone="brand" Icon={IconStack} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* approval queue preview */}
        <div className="rounded-lg border border-slate-200 bg-surface p-4 shadow-sm lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-800">Очередь на согласование</h2>
            {pendingCount > 0 && (
              <Link to="/admin/approvals" className="text-xs font-medium text-brand-600 hover:text-brand-700">
                Все
              </Link>
            )}
          </div>
          {pendingCount === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
                <IconCircleCheck size={22} stroke={1.8} />
              </span>
              <p className="text-sm text-slate-500">Нет публикаций, ожидающих решения.</p>
            </div>
          ) : (
            <ul className="-mx-2 flex flex-col">
              {pendingMeta.map((p) => (
                <li key={`meta-${p.id}`}>
                  <Link
                    to={reviewPath(p)}
                    className="group flex items-center justify-between gap-3 rounded-md px-2 py-2.5 hover:bg-slate-50"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
                        <IconPackage size={16} stroke={1.8} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-slate-800">
                          {chartLabel(p.chart_name)} <span className="text-slate-400">метаданные</span>
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
              {pendingVersions.map((pv) => (
                <li key={`ver-${pv.version.id}`}>
                  <Link
                    to={reviewPath(pv.publication)}
                    className="group flex items-center justify-between gap-3 rounded-md px-2 py-2.5 hover:bg-slate-50"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
                        <IconPackage size={16} stroke={1.8} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-slate-800">
                          {chartLabel(pv.publication.chart_name)}{" "}
                          <span className="text-slate-400">v{pv.version.chart_version}</span>
                        </span>
                        <span className="block truncate text-xs text-slate-400">
                          {pv.publication.chart_project}/{pv.publication.chart_name}
                        </span>
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <Badge tone="brand">{pv.publication.owner_team}</Badge>
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
            desc={pendingCount > 0 ? `${pendingCount} в очереди` : "очередь пуста"}
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
  const { data: pendingVers } = useAsync(() => api.pendingVersions(), []);
  const [filter, setFilter] = useState<Filter>("ALL");

  if (loading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;

  const all = pubs ?? [];
  const pendingVersions = pendingVers ?? [];
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
        badge={<Badge tone="amber">{count("PENDING") + pendingVersions.length} в очереди</Badge>}
      />

      {/* Per-version view submissions awaiting review (separate from the
          publication metadata FSM below). */}
      {pendingVersions.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-amber-200 bg-surface shadow-sm">
          <div className="border-b border-amber-100 bg-amber-50/60 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-amber-800">
            Версии на согласовании
          </div>
          <ul className="flex flex-col">
            {pendingVersions.map((pv) => (
              <li key={pv.version.id} className="border-b border-slate-100 last:border-0">
                <Link
                  to={reviewPath(pv.publication)}
                  className="group flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
                      <IconPackage size={16} stroke={1.8} />
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium text-slate-800">
                        {chartLabel(pv.publication.chart_name)}{" "}
                        <span className="text-slate-400">v{pv.version.chart_version}</span>
                      </span>
                      <span className="block truncate text-xs text-slate-400">
                        {pv.publication.chart_project}/{pv.publication.chart_name}
                      </span>
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge tone="brand">{pv.publication.owner_team}</Badge>
                    <IconArrowRight size={14} className="text-slate-300 group-hover:text-brand-500" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

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
                          to={isPending ? reviewPath(p) : managePath(p)}
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
// Approval detail (one publication)
// ---------------------------------------------------------------------------

// AdminApprovalDetailPage is the dedicated review screen for a single pending
// publication: header + the PublicationReview decision surface. Non-pending
// publications have nothing to decide, so it points to the manage page instead.
export function AdminApprovalDetailPage() {
  const { project = "", name = "" } = useParams();
  const {
    data: pub,
    loading,
    error,
    reload,
  } = useAsync(
    () => api.listPublications({ chart: name }).then((l) => l.find((p) => p.chart_project === project) ?? null),
    [project, name],
  );
  // Pending versions of this chart (per-version submissions to review).
  const { data: versions, reload: reloadVersions } = useAsync(
    () => (pub ? api.listVersions(pub.id) : Promise.resolve([])),
    [pub?.id],
  );
  const pendingVersions = (versions ?? []).filter((v) => v.status === "PENDING");

  const back = (
    <Link
      to="/admin/approvals"
      className="inline-flex w-fit items-center gap-1 text-sm text-slate-500 outline-none hover:text-slate-700 focus-visible:text-brand-600"
    >
      <IconArrowLeft size={16} stroke={1.8} /> Согласование публикаций
    </Link>
  );

  if (loading && !pub) return <Spinner />;
  if (error && !pub) return <ErrorBox error={error} />;
  if (!pub) {
    return (
      <div className="flex flex-col gap-5">
        {back}
        <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Публикация {project}/{name} не найдена.
        </div>
      </div>
    );
  }

  const st = STATUS_META[pub.status];
  return (
    <div className="flex flex-col gap-5">
      {back}
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
          <IconPackage size={20} stroke={1.8} />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold text-slate-900">{chartLabel(pub.chart_name)}</h1>
          <p className="truncate text-xs text-slate-400">
            {pub.chart_project}/{pub.chart_name}
          </p>
        </div>
        <Badge tone={st.tone}>{st.label}</Badge>
        <Badge tone="brand">{pub.owner_team}</Badge>
      </div>

      {/* Metadata (category/owner) approval, if any. */}
      {pub.status === "PENDING" && <PublicationReview pub={pub} onReviewed={reload} />}
      {/* Per-version view submissions awaiting review. */}
      {pendingVersions.map((v) => (
        <VersionReview
          key={v.id}
          pubId={pub.id}
          version={v}
          onReviewed={() => {
            reloadVersions();
            reload();
          }}
        />
      ))}
      {pub.status !== "PENDING" && pendingVersions.length === 0 && (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-slate-200 bg-surface p-4 shadow-sm">
          <p className="text-sm text-slate-600">
            Эта публикация не находится на согласовании, решать нечего. Открыть редактор публикации:
          </p>
          <Link
            to={managePath(pub)}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-surface px-2.5 py-1 text-xs font-medium text-slate-600 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <IconPencil size={14} stroke={1.8} /> Открыть управление
          </Link>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

// Russian plural for "чарт".
function chartsWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "чарт";
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return "чарта";
  return "чартов";
}

export function AdminCategoriesPage() {
  const { categories, charts, reload } = useCatalog();
  const [order, setOrder] = useState<Category[]>(categories);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dragId = useRef<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  // Re-sync local order when the catalog's category set changes (add/remove),
  // keyed by the id list so an in-flight reorder/edit is not clobbered on every
  // render.
  const sig = categories.map((c) => c.id).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: resync on set change only
  useEffect(() => setOrder(categories), [sig]);

  // Charts per category: drives the "can't delete a non-empty category" guard.
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of charts) {
      const id = c.publication?.category_id;
      if (id) m[id] = (m[id] ?? 0) + 1;
    }
    return m;
  }, [charts]);

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

  // Drop the dragged row before the target: renumber sort (10,20,...) and
  // persist only the rows whose position actually changed.
  function onDropOn(targetId: string) {
    const fromId = dragId.current;
    dragId.current = null;
    setOverId(null);
    if (!fromId || fromId === targetId) return;
    const cur = [...order];
    const from = cur.findIndex((c) => c.id === fromId);
    const to = cur.findIndex((c) => c.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = cur.splice(from, 1);
    cur.splice(to, 0, moved);
    const renum = cur.map((c, i) => ({ ...c, sort: (i + 1) * 10 }));
    const prev = order;
    setOrder(renum); // optimistic
    run(async () => {
      for (const c of renum) {
        if (prev.find((o) => o.id === c.id)?.sort !== c.sort) await api.updateCategory(c);
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Категории каталога</h1>
        <p className="mt-1 text-sm text-slate-500">
          Перетаскивайте за ручку для порядка, кликните иконку чтобы сменить. Название и порядок
          сохраняются автоматически.
        </p>
      </div>

      {err && <ErrorBox error={new Error(err)} />}

      <div className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-surface shadow-sm">
        {order.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-slate-500">Категорий нет. Добавьте первую ниже.</p>
        ) : (
          order.map((c) => (
            <CategoryRow
              key={c.id}
              category={c}
              count={counts[c.id] ?? 0}
              busy={busy}
              over={overId === c.id}
              onDragStart={() => {
                dragId.current = c.id;
              }}
              onDragOver={() => setOverId(c.id)}
              onDrop={() => onDropOn(c.id)}
              onRename={(label) => run(() => api.updateCategory({ ...c, label }))}
              onIcon={(icon) =>
                run(async () => {
                  // Optimistic: the resync effect only fires when the id set
                  // changes, so push the new icon into local order ourselves -
                  // otherwise the row keeps rendering the stale icon until reload.
                  setOrder((prev) => prev.map((o) => (o.id === c.id ? { ...o, icon } : o)));
                  await api.updateCategory({ ...c, icon });
                })
              }
              onDelete={() => run(() => api.deleteCategory(c.id))}
            />
          ))
        )}
      </div>

      <AddCategory busy={busy} run={run} />
    </div>
  );
}

function CategoryRow({
  category,
  count,
  busy,
  over,
  onDragStart,
  onDragOver,
  onDrop,
  onRename,
  onIcon,
  onDelete,
}: {
  category: Category;
  count: number;
  busy: boolean;
  over: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onRename: (label: string) => void;
  onIcon: (icon: string) => void;
  onDelete: () => void;
}) {
  const [label, setLabel] = useState(category.label);
  useEffect(() => setLabel(category.label), [category.label]);

  function saveLabel() {
    const v = label.trim();
    if (v && v !== category.label) onRename(v);
    else if (!v) setLabel(category.label); // revert empty edit
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: native HTML5 drag-and-drop reorder (admin-only)
    <div
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      className={`flex items-center gap-3 px-3 py-2.5 ${over ? "bg-brand-50/60" : "hover:bg-slate-50"}`}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: native drag handle */}
      <span
        draggable
        onDragStart={onDragStart}
        title="Перетащить для изменения порядка"
        className="flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded text-slate-300 hover:text-slate-500 active:cursor-grabbing"
      >
        <IconGripVertical size={18} stroke={1.7} />
      </span>

      <IconPicker value={category.icon} disabled={busy} onPick={onIcon} />

      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <input
          value={label}
          disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={saveLabel}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          aria-label="Название категории"
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-medium text-slate-800 outline-none hover:border-slate-200 focus:border-brand-500 focus:bg-surface focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
        />
        <span className="shrink-0 font-mono text-[11px] text-slate-400">{category.id}</span>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {category.system && (
          <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-400">
            <IconLock size={11} stroke={2} />
            системная
          </span>
        )}
        {count > 0 && (
          <span
            title={`${count} ${chartsWord(count)} в категории`}
            className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500"
          >
            <IconPackage size={11} stroke={2} />
            {count}
          </span>
        )}
      </div>

      <DeleteCategoryButton
        deletable={!category.system && count === 0}
        system={!!category.system}
        count={count}
        label={category.label}
        onConfirm={onDelete}
      />
    </div>
  );
}

// IconPicker: a tile showing the current icon; clicking opens a palette popover.
function IconPicker({
  value,
  disabled,
  onPick,
}: {
  value?: string;
  disabled?: boolean;
  onPick: (icon: string) => void;
}) {
  const Current = categoryIcon(value ?? "");
  return (
    <DialogTrigger>
      <AriaButton
        isDisabled={disabled}
        aria-label="Сменить иконку"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-600 outline-none hover:border-brand-300 hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
      >
        <Current size={18} stroke={1.8} />
      </AriaButton>
      <Popover className="rounded-md border border-slate-200 bg-surface p-2 shadow-lg outline-none entering:animate-in entering:fade-in">
        <Dialog className="outline-none" aria-label="Выбор иконки">
          {({ close }) => (
            <div className="grid grid-cols-5 gap-1">
              {CATEGORY_ICON_CHOICES.map(({ id, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    onPick(id);
                    close();
                  }}
                  aria-label={id}
                  className={`flex h-9 w-9 items-center justify-center rounded-md outline-none hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-500 ${
                    value === id ? "bg-brand-50 text-brand-700 ring-1 ring-brand-200" : "text-slate-600"
                  }`}
                >
                  <Icon size={18} stroke={1.8} />
                </button>
              ))}
            </div>
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

// DeleteCategoryButton: a trash control that asks for confirmation in a modal.
// Disabled (with a reason) for the system category or one that still has charts.
function DeleteCategoryButton({
  deletable,
  system,
  count,
  label,
  onConfirm,
}: {
  deletable: boolean;
  system: boolean;
  count: number;
  label: string;
  onConfirm: () => void;
}) {
  if (!deletable) {
    const title = system
      ? "Системную категорию нельзя удалить"
      : `Нельзя удалить: в категории ${count} ${chartsWord(count)}`;
    return (
      <span
        title={title}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-200"
      >
        <IconTrash size={16} stroke={1.8} />
      </span>
    );
  }
  return (
    <DialogTrigger>
      <AriaButton
        aria-label="Удалить категорию"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 outline-none hover:bg-red-50 hover:text-red-600 focus-visible:ring-2 focus-visible:ring-red-500"
      >
        <IconTrash size={16} stroke={1.8} />
      </AriaButton>
      <ModalOverlay
        isDismissable
        className="fixed inset-0 z-10 flex items-start justify-center bg-black/20 p-4 pt-24 entering:animate-in entering:fade-in"
      >
        <Modal className="w-full max-w-md rounded-lg border border-slate-200 bg-surface shadow-xl">
          <Dialog className="outline-none">
            {({ close }) => (
              <div className="flex flex-col gap-4 p-5">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-500">
                    <IconTrash size={20} stroke={1.8} />
                  </span>
                  <div>
                    <Heading slot="title" className="text-base font-semibold text-slate-800">
                      Удалить категорию?
                    </Heading>
                    <p className="mt-1 text-sm text-slate-600">
                      Категория «{label}» будет удалена без возможности восстановления.
                    </p>
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button onPress={close}>Отмена</Button>
                  <Button
                    variant="danger"
                    onPress={() => {
                      onConfirm();
                      close();
                    }}
                  >
                    Удалить
                  </Button>
                </div>
              </div>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}

// slugify derives a url-safe id from a label (latin letters/digits only). For a
// non-latin label it yields "", so the admin types the slug explicitly.
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// A slug must be a url-safe id: lowercase latin/digits in single-dash groups,
// and carry at least SLUG_MIN_LETTERS letters so it stays readable (digits alone
// are not a meaningful id).
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MIN_LETTERS = 2;

// slugError returns a human message for an invalid slug, or null when it is valid
// (or empty - emptiness is handled by disabling the button, not by an error).
function slugError(id: string): string | null {
  if (!id) return null;
  if (!SLUG_RE.test(id)) return "Только строчные латинские буквы, цифры и дефис, без пробелов.";
  if ((id.match(/[a-z]/g)?.length ?? 0) < SLUG_MIN_LETTERS)
    return `Минимум ${SLUG_MIN_LETTERS} латинские буквы.`;
  return null;
}

// AddCategory: a single inline row matching the list style. The slug is
// auto-suggested from the name until the admin edits it; new categories land at
// the end with the chosen icon, then are editable inline above.
function AddCategory({ busy, run }: { busy: boolean; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [icon, setIcon] = useState("box");
  const id = (slugTouched ? slug : slugify(label)).trim();
  const slugErr = slugError(id);
  // Only surface the message once the admin has typed into the slug field; while
  // it is still auto-derived from the name we just disable the button.
  const showSlugErr = slugTouched && !!slug.trim() && !!slugErr;
  const canAdd = !busy && !!label.trim() && !slugErr && !!id;

  function reset() {
    setLabel("");
    setSlug("");
    setSlugTouched(false);
    setIcon("box");
  }
  function add() {
    if (!canAdd) return;
    run(() => api.createCategory({ id, label: label.trim(), sort: 999, icon })).then(reset);
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border border-dashed border-slate-300 bg-surface px-3 py-2.5">
      <span className="h-7 w-7 shrink-0" aria-hidden />
      <IconPicker value={icon} disabled={busy} onPick={setIcon} />
      <input
        value={label}
        disabled={busy}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") add();
        }}
        placeholder="Название новой категории"
        aria-label="Название новой категории"
        className="h-[30px] min-w-0 flex-1 rounded-md border border-slate-200 bg-transparent px-2.5 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
      />
      <div className="relative shrink-0">
        <input
          value={slugTouched ? slug : id}
          disabled={busy}
          onChange={(e) => {
            setSlug(e.target.value);
            setSlugTouched(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="slug"
          aria-label="Идентификатор (slug)"
          aria-invalid={showSlugErr}
          className={`h-[30px] w-32 rounded-md border bg-transparent px-2.5 font-mono text-[11px] text-slate-600 outline-none placeholder:text-slate-400 focus:ring-1 disabled:opacity-50 ${
            showSlugErr
              ? "border-red-400 focus:border-red-500 focus:ring-red-500"
              : "border-slate-200 focus:border-brand-500 focus:ring-brand-500"
          }`}
        />
        {showSlugErr && (
          <div
            role="alert"
            className="absolute bottom-full right-0 z-20 mb-2 w-56 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs leading-snug text-red-700 shadow-md"
          >
            <div className="flex items-start gap-1.5">
              <IconAlertTriangle size={14} stroke={2} className="mt-px shrink-0" />
              <span>{slugErr}</span>
            </div>
            <span className="absolute right-6 top-full h-2 w-2 -translate-y-1/2 rotate-45 border-b border-r border-red-200 bg-red-50" />
          </div>
        )}
      </div>
      <AriaButton
        isDisabled={!canAdd}
        onPress={add}
        aria-label="Добавить категорию"
        className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md bg-brand-600 text-on-accent outline-none hover:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-40"
      >
        <IconPlus size={16} stroke={2} />
      </AriaButton>
    </div>
  );
}
