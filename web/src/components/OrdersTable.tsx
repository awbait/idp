import { IconAlertTriangle, IconArrowRight, IconArrowsSort, IconArrowUpCircle, IconCheck, IconChevronDown, IconDots, IconGitFork, IconPackages, IconPlus, IconSearch, IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Cell,
  Column,
  Dialog,
  DialogTrigger,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  Row,
  Table,
  TableBody,
  TableHeader,
} from "react-aria-components";
import { Link, useNavigate } from "react-router-dom";
import { api, errorMessage, HttpError } from "../api/client";
import type { OrderRequest, RequestStatus } from "../api/types";
import { useCatalog } from "../app/CatalogContext";
import { useTeam } from "../app/TeamContext";
import { useToast } from "../app/ToastContext";
import { canModify, useUser } from "../auth/UserContext";
import { useAsync } from "../hooks/useAsync";
import { isNewer } from "../lib/semver";
import { attachSseLogger } from "../lib/sse";
import { ConfirmDialog } from "./ConfirmDialog";
import { ProductIcon } from "./icons";
import { StatusBadge, StatusDot } from "./StatusBadge";
import { ErrorBox, Spinner } from "./ui";

// Live order statuses (create-MR merged): only these can be upgraded to a new version.
const LIVE_STATUSES: RequestStatus[] = ["MR_MERGED", "DEPLOYING", "HEALTHY", "DEGRADED", "ARGO_MISSING"];

interface Props {
  title: string;
  // Extra filter applied on top of the active-team filter (e.g. by product).
  filter?: (r: OrderRequest) => boolean;
  // When set, render an "Заказать" button linking to this route.
  orderTo?: string;
  // When set (and orderTo is not), render a disabled "Заказать" button with this
  // reason as a tooltip/label (e.g. the product's chart isn't in the registry).
  orderDisabledReason?: string;
  // Hint shown when the table is empty.
  emptyHint?: React.ReactNode;
  // Cross-team view (support/admin): ignore the active-team filter and add a
  // "Команда" column so it's clear which team owns each order.
  allTeams?: boolean;
}

// Statuses offered in the filter, in lifecycle order. DELETED is hidden by default.
const STATUSES: RequestStatus[] = [
  "DRAFT",
  "MR_CREATED",
  "MR_MERGED",
  "DEPLOYING",
  "HEALTHY",
  "DEGRADED",
  "ARGO_MISSING",
  "DELETE_REQUESTED",
  "DELETE_MR_MERGED",
  "MR_CLOSED",
  "DELETED",
];
const DEFAULT_HIDDEN: RequestStatus[] = ["DELETED"];

export function OrdersTable({ title, filter, orderTo, orderDisabledReason, emptyHint, allTeams }: Props) {
  // Fetch including deleted so the status filter can reveal them on demand.
  const { data, error, loading, reload } = useAsync(
    () => api.listRequests({ include_deleted: "true" }),
    [],
  );

  // Live updates: a global SSE stream pushes a "status_changed" signal on any
  // request status change; we re-fetch the (team-scoped) list. Browser handles
  // reconnect. One-way server->client - SSE, not WebSockets.
  useEffect(() => {
    const es = new EventSource("/api/v1/requests/events");
    attachSseLogger(es, "orders");
    es.addEventListener("status_changed", () => reload());
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { team } = useTeam();
  const { user } = useUser();
  const navigate = useNavigate();
  const toast = useToast();

  // Order's category label from its chart's publication (for the "Category" column).
  const { categories, charts } = useCatalog();
  const categoryOf = (project: string, name: string) => {
    const pub = charts.find((c) => c.project === project && c.name === name)?.publication;
    return categories.find((c) => c.id === pub?.category_id)?.label;
  };
  // Approved version newer than the order's version -> an upgrade is available
  // (only for live, non-drifted orders).
  const upgradeFor = (r: OrderRequest): string | null => {
    if (!LIVE_STATUSES.includes(r.status) || r.drifted) return null;
    const v = charts.find((c) => c.project === r.chart_project && c.name === r.chart_name)
      ?.publication?.approved_view_version;
    return v && isNewer(v, r.chart_version) ? v : null;
  };

  const [shown, setShown] = useState<Set<RequestStatus>>(
    () => new Set(STATUSES.filter((s) => !DEFAULT_HIDDEN.includes(s))),
  );
  const [newestFirst, setNewestFirst] = useState(true);
  // Cross-team facet filters (only used when allTeams). Empty set = no filter.
  const [teamFilter, setTeamFilter] = useState<Set<string>>(new Set());
  const [productFilter, setProductFilter] = useState<Set<string>>(new Set());
  // The order pending delete confirmation (null = dialog closed).
  const [deleting, setDeleting] = useState<OrderRequest | null>(null);

  // Distinct teams/products present in the data, for the facet filter options.
  const teamOptions = useMemo(
    () => [...new Set((data ?? []).map((r) => r.team))].filter(Boolean).sort(),
    [data],
  );
  const productOptions = useMemo(
    () => [...new Set((data ?? []).map((r) => r.chart_name))].filter(Boolean).sort(),
    [data],
  );

  const rows = useMemo(() => {
    const base = (data ?? [])
      .filter((r) => allTeams || !team || r.team === team)
      .filter((r) => teamFilter.size === 0 || teamFilter.has(r.team))
      .filter((r) => productFilter.size === 0 || productFilter.has(r.chart_name))
      .filter((r) => (filter ? filter(r) : true))
      .filter((r) => shown.has(r.status));
    const dir = newestFirst ? -1 : 1;
    return [...base].sort((a, b) => {
      // Drafts always on top, regardless of the date direction.
      const ad = a.status === "DRAFT" ? 0 : 1;
      const bd = b.status === "DRAFT" ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return dir * (new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    });
  }, [data, team, filter, shown, newestFirst, allTeams, teamFilter, productFilter]);

  if (loading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;

  async function onSync(r: OrderRequest) {
    try {
      await api.syncRequest(r.id);
      toast.success("Выкатка из Git запущена");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  async function onConfirmDelete() {
    if (!deleting) return;
    try {
      await api.deleteRequest(deleting.id);
      reload();
    } catch (e) {
      // An open MR blocks deletion: explain it in Russian (ConfirmDialog renders
      // a thrown message inline) instead of the bare English domain string.
      if (e instanceof HttpError && e.code === "open_mr") {
        throw new Error(
          `Уже открыт запрос на слияние${e.mrIid ? ` #${e.mrIid}` : ""} для этого сервиса. Дождитесь его обработки или закройте его, прежде чем удалять сервис.`,
        );
      }
      throw e;
    }
  }

  const filtersDefault =
    newestFirst &&
    teamFilter.size === 0 &&
    productFilter.size === 0 &&
    STATUSES.every((s) => shown.has(s) === !DEFAULT_HIDDEN.includes(s));
  const resetFilters = () => {
    setShown(new Set(STATUSES.filter((s) => !DEFAULT_HIDDEN.includes(s))));
    setNewestFirst(true);
    setTeamFilter(new Set());
    setProductFilter(new Set());
  };

  return (
    <div>
      <div className="mb-4 flex min-h-9 items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {orderTo ? (
          <Link
            to={orderTo}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-brand-700"
          >
            <IconPlus size={16} stroke={2} />
            Заказать
          </Link>
        ) : orderDisabledReason ? (
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-slate-400 sm:inline">нет в реестре</span>
            <span
              title={orderDisabledReason}
              aria-disabled="true"
              className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-md bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-300"
            >
              <IconPlus size={16} stroke={2} />
              Заказать
            </span>
          </div>
        ) : null}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {allTeams && (
          <>
            <SearchFilter
              label="Команды"
              searchPlaceholder="Найти команду..."
              options={teamOptions}
              selected={teamFilter}
              onChange={setTeamFilter}
            />
            <SearchFilter
              label="Продукты"
              searchPlaceholder="Найти продукт..."
              options={productOptions}
              selected={productFilter}
              onChange={setProductFilter}
            />
          </>
        )}
        <StatusFilter shown={shown} onChange={setShown} />
        <button
          onClick={() => setNewestFirst((v) => !v)}
          className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <IconArrowsSort size={13} stroke={1.8} className="text-slate-400" />
          {newestFirst ? "Сначала новые" : "Сначала старые"}
        </button>
        {!filtersDefault && (
          <button
            onClick={resetFilters}
            className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-slate-500 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <IconX size={13} stroke={2} />
            Сбросить
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-surface shadow-sm">
        <Table aria-label={title} className="w-full text-sm">
          <TableHeader className="border-b border-slate-200 bg-slate-50 text-xs font-medium uppercase tracking-wide text-slate-500">
            <Column className="px-4 py-2.5 text-left">Категория</Column>
            {allTeams && <Column className="px-4 py-2.5 text-left">Команда</Column>}
            <Column className="px-4 py-2.5 text-left">Продукт</Column>
            <Column isRowHeader className="px-4 py-2.5 text-left">Имя</Column>
            <Column className="px-4 py-2.5 text-left">Метка</Column>
            <Column className="px-4 py-2.5 text-left">Создатель</Column>
            <Column className="px-4 py-2.5 text-right">Дата создания</Column>
            <Column className="px-4 py-2.5 text-center">Статус</Column>
            <Column className="w-12 px-4 py-2.5">
              <span className="sr-only">Действия</span>
            </Column>
          </TableHeader>
          <TableBody
            renderEmptyState={() => (
              <div className="px-4 py-12 text-center text-sm text-slate-500">
                {emptyHint ?? (
                  <div className="flex flex-col items-center gap-3">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                      <IconPackages size={24} stroke={1.6} />
                    </span>
                    <p>Заказов пока нет</p>
                    <Link
                      to="/catalog"
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-surface px-3 py-1.5 font-medium text-slate-700 outline-none transition-colors hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500"
                    >
                      Открыть каталог
                      <IconArrowRight size={16} stroke={1.7} className="text-slate-400" />
                    </Link>
                  </div>
                )}
              </div>
            )}
          >
            {rows.map((r) => {
              const isDraft = r.status === "DRAFT";
              const modifiable = canModify(user, r.team) && r.status !== "DELETED";
              return (
                <Row
                  key={r.id}
                  onAction={() => navigate(isDraft ? `/requests/${r.id}/edit` : `/requests/${r.id}`)}
                  className="cursor-pointer border-b border-slate-100 outline-none last:border-0 hover:bg-slate-50 focus-visible:bg-slate-50"
                >
                  <Cell className="px-4 py-3 text-left text-slate-500">
                    {categoryOf(r.chart_project, r.chart_name) ?? r.chart_project}
                  </Cell>
                  {allTeams && <Cell className="px-4 py-3 text-left text-slate-600">{r.team}</Cell>}
                  <Cell className="px-4 py-3 text-left">
                    <span className="flex items-center gap-2 font-medium text-slate-800">
                      <ProductIcon project={r.chart_project} name={r.chart_name} />
                      {r.chart_name}
                    </span>
                  </Cell>
                  <Cell className="px-4 py-3 text-left">
                    {/* A draft can't be opened (no detail) - its name leads to the edit form. */}
                    <span className="flex items-center gap-1.5">
                      <Link
                        to={isDraft ? `/requests/${r.id}/edit` : `/requests/${r.id}`}
                        className="font-medium text-slate-800 transition-colors hover:text-slate-950"
                      >
                        {r.service_name}
                      </Link>
                      {r.imported && (
                        <span
                          title="Импортировано из Git (создано вне портала)"
                          className="inline-flex items-center gap-0.5 rounded bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-700"
                        >
                          <IconGitFork size={12} stroke={2} />
                          Импорт
                        </span>
                      )}
                      {r.drifted && (
                        <span
                          title={r.drift_detail || "Изменено в Git вне портала"}
                          className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700"
                        >
                          <IconAlertTriangle size={12} stroke={2} />
                          Git
                        </span>
                      )}
                      {(() => {
                        const up = upgradeFor(r);
                        return up ? (
                          <Link
                            to={`/requests/${r.id}/upgrade?to=${encodeURIComponent(up)}`}
                            onClick={(e) => e.stopPropagation()}
                            title={`Доступно обновление до ${up}`}
                            className="inline-flex items-center gap-0.5 rounded bg-brand-50 px-1.5 py-0.5 text-xs font-medium text-brand-700 hover:bg-brand-100"
                          >
                            <IconArrowUpCircle size={12} stroke={2} />
                            {up}
                          </Link>
                        ) : null;
                      })()}
                    </span>
                  </Cell>
                  <Cell className="px-4 py-3 text-left text-slate-600">{r.display_name || "-"}</Cell>
                  <Cell className="px-4 py-3 text-left text-slate-500">{r.created_by_name}</Cell>
                  <Cell className="whitespace-nowrap px-4 py-3 text-right text-slate-600">
                    {fmtDateTime(r.created_at)}
                  </Cell>
                  <Cell className="px-4 py-3 text-center">
                    <StatusDot status={r.status} />
                  </Cell>
                  <Cell className="px-4 py-3 text-right">
                    <RowActions
                      isDraft={isDraft}
                      onOpen={() => navigate(`/requests/${r.id}`)}
                      onContinue={() => navigate(`/requests/${r.id}/edit`)}
                      onSync={!isDraft && user?.role === "admin" ? () => onSync(r) : undefined}
                      onDelete={modifiable ? () => setDeleting(r) : undefined}
                    />
                  </Cell>
                </Row>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <ConfirmDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        danger
        title={deleting?.status === "DRAFT" ? "Удалить черновик?" : "Удалить сервис?"}
        confirmLabel="Удалить"
        busyLabel="Удаляем…"
        message={
          deleting?.status === "DRAFT" ? (
            <>
              Черновик <strong>{deleting?.display_name || deleting?.service_name}</strong> будет
              удалён без возможности восстановления.
            </>
          ) : (
            <>
              Сервис <strong>{deleting?.service_name}</strong> будет удалён.
            </>
          )
        }
        onConfirm={onConfirmDelete}
      />
    </div>
  );
}

// StatusFilter is one chip opening a multi-select of which statuses to show
// (DELETED off by default).
function StatusFilter({
  shown,
  onChange,
}: {
  shown: Set<RequestStatus>;
  onChange: (s: Set<RequestStatus>) => void;
}) {
  return (
    <MenuTrigger>
      <Button className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500">
        Статусы
        <span className="text-slate-400">
          {shown.size}/{STATUSES.length}
        </span>
        <IconChevronDown size={13} stroke={1.8} className="text-slate-400" />
      </Button>
      <Popover className="rounded-md border border-slate-200 bg-surface py-1 shadow-lg outline-none entering:animate-in entering:fade-in">
        <Menu
          selectionMode="multiple"
          selectedKeys={shown}
          onSelectionChange={(keys) =>
            onChange(keys === "all" ? new Set(STATUSES) : new Set([...keys].map(String) as RequestStatus[]))
          }
          className="max-h-80 overflow-auto outline-none"
        >
          {STATUSES.map((s) => (
            <MenuItem
              key={s}
              id={s}
              textValue={s}
              className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm outline-none focus:bg-slate-50"
            >
              {({ isSelected }) => (
                <>
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      isSelected ? "border-brand-600 bg-brand-600 text-on-accent" : "border-slate-300"
                    }`}
                  >
                    {isSelected && <IconCheck size={12} stroke={3} />}
                  </span>
                  <StatusBadge status={s} />
                </>
              )}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

// SearchFilter is a chip that opens a popover with a search box and a checkbox
// list - for facets with many values (teams, products) where typing to narrow
// down is faster than scanning. Empty selection means "no filter" (show all).
function SearchFilter({
  label,
  searchPlaceholder,
  options,
  selected,
  onChange,
}: {
  label: string;
  searchPlaceholder: string;
  options: string[];
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
}) {
  const [q, setQ] = useState("");
  const filtered = q
    ? options.filter((o) => o.toLowerCase().includes(q.toLowerCase()))
    : options;
  const toggle = (v: string) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange(next);
  };
  const active = selected.size > 0;
  return (
    <DialogTrigger>
      <Button
        className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
          active
            ? "border-brand-200 bg-brand-50 text-brand-700"
            : "border-slate-200 text-slate-600 hover:bg-slate-50"
        }`}
      >
        {label}
        {active && <span className="text-brand-500">{selected.size}</span>}
        <IconChevronDown size={13} stroke={1.8} className={active ? "text-brand-400" : "text-slate-400"} />
      </Button>
      <Popover className="w-60 rounded-md border border-slate-200 bg-surface shadow-lg outline-none entering:animate-in entering:fade-in">
        <Dialog className="outline-none">
          <div className="border-b border-slate-100 p-2">
            <div className="relative">
              <IconSearch size={14} stroke={1.8} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                autoFocus
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full rounded-md border border-slate-200 bg-surface py-1 pl-7 pr-2 text-sm outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
              />
            </div>
          </div>
          <ul className="max-h-64 overflow-auto p-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-xs text-slate-400">Ничего не найдено</li>
            ) : (
              filtered.map((o) => {
                const isSelected = selected.has(o);
                return (
                  <li key={o}>
                    <button
                      type="button"
                      onClick={() => toggle(o)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-slate-50 focus-visible:bg-slate-50"
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          isSelected ? "border-brand-600 bg-brand-600 text-on-accent" : "border-slate-300"
                        }`}
                      >
                        {isSelected && <IconCheck size={12} stroke={3} />}
                      </span>
                      <span className="truncate text-slate-700">{o}</span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          {active && (
            <div className="border-t border-slate-100 p-1">
              <button
                type="button"
                onClick={() => onChange(new Set())}
                className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs font-medium text-slate-500 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <IconX size={13} stroke={2} />
                Сбросить ({selected.size})
              </button>
            </div>
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function RowActions({
  isDraft,
  onOpen,
  onContinue,
  onSync,
  onDelete,
}: {
  isDraft: boolean;
  onOpen: () => void;
  onContinue: () => void;
  onSync?: () => void;
  onDelete?: () => void;
}) {
  return (
    <MenuTrigger>
      <Button
        aria-label="Действия"
        className="inline-flex rounded-md p-1 text-slate-400 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <IconDots size={18} stroke={1.7} />
      </Button>
      <Popover className="min-w-44 rounded-md border border-slate-200 bg-surface py-1 shadow-lg outline-none entering:animate-in entering:fade-in">
        <Menu
          className="outline-none"
          onAction={(key) => {
            if (key === "open") onOpen();
            else if (key === "continue") onContinue();
            else if (key === "sync") onSync?.();
            else if (key === "delete") onDelete?.();
          }}
        >
          {isDraft ? (
            <MenuItem id="continue" className="cursor-pointer px-3 py-1.5 text-sm text-slate-700 outline-none focus:bg-slate-50">
              Продолжить
            </MenuItem>
          ) : (
            <MenuItem id="open" className="cursor-pointer px-3 py-1.5 text-sm text-slate-700 outline-none focus:bg-slate-50">
              Открыть
            </MenuItem>
          )}
          {onSync && (
            <MenuItem id="sync" className="cursor-pointer px-3 py-1.5 text-sm text-slate-700 outline-none focus:bg-slate-50">
              Выкатить из Git
            </MenuItem>
          )}
          {onDelete && (
            <MenuItem id="delete" className="cursor-pointer px-3 py-1.5 text-sm text-red-600 outline-none focus:bg-red-50">
              Удалить
            </MenuItem>
          )}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}
