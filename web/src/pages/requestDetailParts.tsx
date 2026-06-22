// Shared presentational pieces of the request (product) detail page (RequestDetailPage):
// detail actions, tabs, fields, history, the raw-values modal and date formatting.
// Kept as a separate module so the page component stays focused on data flow.
import { useEffect, useState } from "react";
import {
  Button as AriaButton,
  Dialog,
  DialogTrigger,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  ModalOverlay,
  Popover,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from "react-aria-components";
import Editor from "@monaco-editor/react";
import {
  IconArrowRight,
  IconChevronLeft,
  IconChevronRight,
  IconCircleX,
  IconDotsVertical,
  IconExternalLink,
  IconFileCode,
  IconForms,
  IconAlertTriangle,
  IconGitBranch,
  IconGitCommit,
  IconGitFork,
  IconGitMerge,
  IconGitPullRequest,
  IconGitPullRequestClosed,
  IconHistory,
  IconPencil,
  IconRefresh,
  IconSparkles,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { Card } from "../components/ui";
import { safeHref } from "../lib/href";
import { StatusBadge, statusMeta } from "../components/StatusBadge";
import { useTheme } from "../app/ThemeContext";
import { productTabs } from "../components/products/genericView";
import {
  GenericInfoActions,
  GenericListTab,
  type PersistValues,
} from "../components/products/GenericProductTabs";
import type { OrderRequest, RequestDetail, RequestEvent, RequestMR, ViewDocument } from "../api/types";

export function Meta({
  label,
  children,
  align = "start",
}: {
  label: string;
  children: React.ReactNode;
  align?: "start" | "end";
}) {
  return (
    <div className={`flex flex-col gap-1 ${align === "end" ? "items-end text-right" : "items-start"}`}>
      <span className="text-xs uppercase tracking-wide text-gray-400">{label}</span>
      {children}
    </div>
  );
}

// DetailTab is a styled react-aria Tab with an underline indicator.
export function DetailTab({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <Tab
      id={id}
      className="-mb-px cursor-pointer border-b-2 border-transparent px-3 py-2 text-sm font-medium text-gray-500 outline-none transition-colors hover:text-gray-700 selected:border-brand-600 selected:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      {children}
    </Tab>
  );
}

export function Field({ label, value, href }: { label: string; value: string; href?: string }) {
  const safe = safeHref(href);
  return (
    <div>
      <div className="text-xs uppercase text-gray-400">{label}</div>
      {safe && value ? (
        <a
          href={safe}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex items-center gap-1 text-brand-600 hover:text-brand-700 hover:underline"
        >
          {value}
          <IconExternalLink size={14} stroke={1.8} className="text-brand-400 group-hover:text-brand-600" />
        </a>
      ) : (
        <div className="text-gray-800">{value || "-"}</div>
      )}
    </div>
  );
}

// DetailActions is the header's actions dropdown (vertical dots). It renders
// only the actions available for the current order/role; nothing if there are none.
export function DetailActions({
  isDraft,
  onContinue,
  onSubmit,
  onSync,
  onUpgrade,
  onDelete,
  notify = false,
}: {
  isDraft: boolean;
  onContinue?: () => void;
  onSubmit?: () => void;
  onSync?: () => void;
  onUpgrade?: () => void;
  onDelete?: () => void;
  // Show a notification dot on the trigger (e.g. an upgrade is available).
  notify?: boolean;
}) {
  if (!onContinue && !onSubmit && !onSync && !onUpgrade && !onDelete) return null;
  const item = "cursor-pointer px-3 py-1.5 text-sm text-slate-700 outline-none focus:bg-slate-50";
  return (
    <MenuTrigger>
      <AriaButton className="relative inline-flex shrink-0 items-center gap-1.5 rounded-md border border-brand-200 bg-surface px-3 py-1.5 text-sm font-medium text-brand-600 outline-none hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-500">
        <IconDotsVertical size={16} stroke={1.8} className="text-brand-600" />
        Действия
        {notify && (
          <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-brand-500 ring-2 ring-surface" />
        )}
      </AriaButton>
      <Popover className="min-w-48 rounded-md border border-slate-200 bg-surface py-1 shadow-lg outline-none entering:animate-in entering:fade-in">
        <Menu
          className="outline-none"
          onAction={(key) => {
            if (key === "continue") onContinue?.();
            else if (key === "submit") onSubmit?.();
            else if (key === "sync") onSync?.();
            else if (key === "upgrade") onUpgrade?.();
            else if (key === "delete") onDelete?.();
          }}
        >
          {onContinue && (
            <MenuItem id="continue" className={item}>
              Продолжить редактирование
            </MenuItem>
          )}
          {onSubmit && (
            <MenuItem id="submit" className={item}>
              Заказать
            </MenuItem>
          )}
          {onUpgrade && (
            <MenuItem id="upgrade" className={item}>
              Обновить
            </MenuItem>
          )}
          {onSync && (
            <MenuItem id="sync" className={item}>
              Синхронизировать
            </MenuItem>
          )}
          {onDelete && (
            <MenuItem
              id="delete"
              className="cursor-pointer px-3 py-1.5 text-sm text-red-600 outline-none focus:bg-red-50"
            >
              {isDraft ? "Удалить черновик" : "Удалить"}
            </MenuItem>
          )}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

// ValuesModalButton opens the read-only values.yaml in a centered modal.
export function ValuesModalButton({ request: r }: { request: RequestDetail["request"] }) {
  const { theme } = useTheme();
  return (
    <DialogTrigger>
      <AriaButton className="mb-2 inline-flex shrink-0 items-center gap-1.5 rounded-md border border-gray-300 bg-surface px-3 py-1.5 text-sm font-medium text-gray-700 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-brand-500">
        <IconFileCode size={16} stroke={1.8} className="text-gray-400" />
        values.yaml
      </AriaButton>
      <ModalOverlay className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 entering:animate-in entering:fade-in">
        <Modal className="w-full max-w-3xl rounded-lg bg-surface shadow-xl outline-none entering:animate-in entering:zoom-in-95">
          <Dialog className="outline-none">
            {({ close }) => (
              <div className="flex flex-col">
                <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
                  <h2 className="text-sm font-semibold text-gray-700">values.yaml</h2>
                  <button
                    onClick={close}
                    aria-label="Закрыть"
                    className="rounded-md p-1 text-gray-400 outline-none hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <IconX size={18} stroke={2} />
                  </button>
                </header>
                <div className="overflow-hidden rounded-b-lg">
                  <Editor
                    height="480px"
                    defaultLanguage="yaml"
                    theme={theme === "light" ? "light" : "vs-dark"}
                    value={r.values_yaml}
                    options={{
                      readOnly: true,
                      minimap: { enabled: false },
                      fontSize: 13,
                      automaticLayout: true,
                    }}
                  />
                </div>
              </div>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// fmtRelative renders a compact "X ago" label (abbreviations dodge RU plural
// forms); falls back to the absolute date past a week. Full date is in title=.
export function fmtRelative(iso: string): string {
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return "только что";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} мин назад`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ч назад`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} дн назад`;
  return fmtDateTime(iso);
}

// ---- Activity history: timeline + merge requests (MRs) ----

type TablerIcon = typeof IconHistory;

const TL_PREVIEW = 5; // events shown inline before "show all"
const MODAL_PAGE = 10; // events per page in the modal

const tints: Record<string, string> = {
  slate: "bg-slate-100 text-slate-600",
  indigo: "bg-indigo-100 text-indigo-600",
  blue: "bg-blue-100 text-blue-600",
  rose: "bg-rose-100 text-rose-600",
  amber: "bg-amber-100 text-amber-700",
  emerald: "bg-emerald-100 text-emerald-600",
  sky: "bg-sky-100 text-sky-600",
};

const EVENT_META: Record<string, { label: string; Icon: TablerIcon; tint: string }> = {
  created: { label: "Заказ создан", Icon: IconSparkles, tint: "indigo" },
  draft_updated: { label: "Черновик изменён", Icon: IconPencil, tint: "slate" },
  renamed: { label: "Переименован", Icon: IconForms, tint: "slate" },
  draft_discarded: { label: "Черновик отброшен", Icon: IconTrash, tint: "slate" },
  sync_forced: { label: "Запрошена синхронизация", Icon: IconRefresh, tint: "blue" },
  deleted: { label: "Сервис удалён", Icon: IconCircleX, tint: "rose" },
  drift_detected: { label: "Обнаружено изменение в Git", Icon: IconAlertTriangle, tint: "amber" },
  drift_cleared: { label: "Расхождение с Git устранено", Icon: IconGitMerge, tint: "emerald" },
  git_pulled: { label: "Обновлено из Git", Icon: IconGitFork, tint: "sky" },
  imported: { label: "Импортировано из Git", Icon: IconGitFork, tint: "sky" },
};

// ProductView is the view-driven body of the product (order) page: the tab strip
// (Info + one tab per product view + Activity history) and the
// values.yaml button. It is shared by RequestDetailPage (live order, writes via
// the API) and the chart-manage preview (synthetic order, writes to local state
// via `persist` and uses the in-editor `schema`), so both render identically.
export function ProductView({
  request: r,
  doc,
  events = [],
  mrs = [],
  argocdUrl,
  modifiable,
  reload,
  schema,
  persist,
  activeTab,
  onTab,
}: {
  request: OrderRequest;
  doc: ViewDocument;
  events?: NonNullable<RequestDetail["events"]>;
  mrs?: NonNullable<RequestDetail["merge_requests"]>;
  argocdUrl?: string;
  modifiable: boolean;
  reload: () => void;
  // Preview only: preloaded schema + local save adapter (no API).
  schema?: Record<string, any>;
  persist?: PersistValues;
  // Controlled active tab (RequestDetailPage syncs it to the URL). When omitted,
  // ProductView keeps its own tab state (preview).
  activeTab?: string;
  onTab?: (key: string) => void;
}) {
  const [internalTab, setInternalTab] = useState("info");
  const tabs = productTabs(doc);
  const tabIds = ["info", ...tabs.map((t) => t.id), "history"];
  const controlled = onTab !== undefined;
  const requested = controlled ? (activeTab ?? "") : internalTab;
  const active = tabIds.includes(requested) ? requested : "info";
  const setActive = controlled ? onTab! : setInternalTab;

  return (
    <Tabs selectedKey={active} onSelectionChange={(key) => setActive(String(key))}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200">
        <TabList aria-label="Разделы заказа" className="flex gap-1">
          <DetailTab id="info">Общая информация</DetailTab>
          {tabs.map((t) => (
            <DetailTab key={t.id} id={t.id}>
              {t.title ?? t.id}
            </DetailTab>
          ))}
          <DetailTab id="history">История действий</DetailTab>
        </TabList>
        <ValuesModalButton request={r} />
      </div>

      <TabPanel id="info" className="pt-5 outline-none">
        <InfoTab
          request={r}
          argocdUrl={argocdUrl}
          modifiable={modifiable}
          doc={doc}
          onChanged={reload}
          schema={schema}
          persist={persist}
        />
      </TabPanel>
      {tabs.map((t) => (
        <TabPanel key={t.id} id={t.id} className="pt-5 outline-none">
          <Card>
            <GenericListTab
              request={r}
              modifiable={modifiable}
              reload={reload}
              doc={doc}
              tab={t}
              schema={schema}
              persist={persist}
            />
          </Card>
        </TabPanel>
      ))}
      <TabPanel id="history" className="pt-5 outline-none">
        <HistoryTab events={events} mrs={mrs} />
      </TabPanel>
    </Tabs>
  );
}

function InfoTab({
  request: r,
  argocdUrl,
  modifiable,
  doc,
  onChanged,
  schema,
  persist,
}: {
  request: OrderRequest;
  argocdUrl?: string;
  modifiable: boolean;
  doc: ViewDocument;
  onChanged: () => void;
  schema?: Record<string, any>;
  persist?: PersistValues;
}) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-700">Общая информация</h2>
        {modifiable && (
          <GenericInfoActions
            request={r}
            doc={doc}
            onChanged={onChanged}
            schema={schema}
            persist={persist}
          />
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
        <Field label="Service name" value={r.service_name} />
        <Field label="Chart" value={`${r.chart_project}/${r.chart_name}`} />
        <Field label="Version" value={r.chart_version} />
        <Field label="Team" value={r.team} />
        <Field label="Cluster" value={r.cluster} />
        <Field label="Namespace" value={r.namespace} />
        <Field label="ArgoCD App" value={r.argocd_app_name} href={argocdUrl} />
      </div>
    </Card>
  );
}

export function HistoryTab({
  events,
  mrs,
}: {
  events: NonNullable<RequestDetail["events"]>;
  mrs: NonNullable<RequestDetail["merge_requests"]>;
}) {
  const evts = [...events].sort((a, b) => b.id - a.id);
  const mrList = [...mrs].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <TimelineCard events={evts} />
      <MergeRequestsCard mrs={mrList} />
    </div>
  );
}

function SectionHeader({ Icon, title, count }: { Icon: TablerIcon; title: string; count: number }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-50 text-brand-600">
        <Icon size={16} stroke={1.8} />
      </span>
      <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">{count}</span>
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-sm text-slate-400">{children}</p>;
}

function TimelineCard({ events }: { events: RequestEvent[] }) {
  const [showAll, setShowAll] = useState(false);
  return (
    <Card>
      <SectionHeader Icon={IconHistory} title="Хронология" count={events.length} />
      {events.length === 0 ? (
        <EmptyHint>Событий пока нет.</EmptyHint>
      ) : (
        <Timeline items={events.slice(0, TL_PREVIEW)} />
      )}
      {events.length > TL_PREVIEW && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-brand-600 outline-none hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          Показать все ({events.length})
        </button>
      )}
      <TimelineModal events={events} isOpen={showAll} onOpenChange={setShowAll} />
    </Card>
  );
}

function Timeline({ items }: { items: RequestEvent[] }) {
  return (
    <ol className="relative">
      {items.map((e, i) => (
        <TimelineRow key={e.id} e={e} last={i === items.length - 1} />
      ))}
    </ol>
  );
}

function TimelineRow({ e, last }: { e: RequestEvent; last: boolean }) {
  const isStatus = e.event_type === "status_changed";
  const sMeta = e.to_status ? statusMeta(e.to_status) : null;
  const meta = EVENT_META[e.event_type];
  const circle = isStatus && sMeta ? sMeta.badge : tints[meta?.tint ?? "slate"];
  const Icon = (isStatus && sMeta ? sMeta.staticIcon ?? sMeta.Icon : meta?.Icon) ?? IconHistory;
  return (
    <li className="relative flex gap-3 pb-5 last:pb-1">
      {!last && <span className="absolute bottom-0 left-[15px] top-8 w-px bg-slate-200" aria-hidden />}
      <span className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-4 ring-surface ${circle}`}>
        <Icon size={16} stroke={1.8} />
      </span>
      <div className="min-w-0 flex-1 pt-1">
        {isStatus ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {e.from_status && <StatusBadge status={e.from_status} muted noSpin />}
            {e.from_status && <IconArrowRight size={14} className="text-slate-300" />}
            {e.to_status && <StatusBadge status={e.to_status} noSpin />}
          </div>
        ) : (
          <span className="text-sm font-medium text-slate-800">{meta?.label ?? e.event_type}</span>
        )}
        <div className="mt-1 text-xs text-slate-400" title={fmtDateTime(e.created_at)}>
          {e.actor} · {fmtRelative(e.created_at)}
        </div>
      </div>
    </li>
  );
}

function TimelineModal({
  events,
  isOpen,
  onOpenChange,
}: {
  events: RequestEvent[];
  isOpen: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [page, setPage] = useState(1);
  useEffect(() => {
    if (isOpen) setPage(1);
  }, [isOpen]);
  const pages = Math.max(1, Math.ceil(events.length / MODAL_PAGE));
  const slice = events.slice((page - 1) * MODAL_PAGE, page * MODAL_PAGE);
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 entering:animate-in entering:fade-in"
    >
      <Modal className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg bg-surface shadow-xl outline-none entering:animate-in entering:zoom-in-95">
        <Dialog className="flex max-h-[85vh] flex-col outline-none">
          {({ close }) => (
            <>
              <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
                <SectionHeaderInline Icon={IconHistory} title="Хронология" count={events.length} />
                <button
                  onClick={close}
                  aria-label="Закрыть"
                  className="rounded-md p-1 text-slate-400 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <IconX size={18} stroke={2} />
                </button>
              </header>
              <div className="flex-1 overflow-y-auto px-5 py-4">
                <Timeline items={slice} />
              </div>
              {pages > 1 && (
                <footer className="border-t border-slate-200 px-5 py-3">
                  <Pagination page={page} pages={pages} onChange={setPage} />
                </footer>
              )}
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function SectionHeaderInline({ Icon, title, count }: { Icon: TablerIcon; title: string; count: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-50 text-brand-600">
        <Icon size={16} stroke={1.8} />
      </span>
      <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">{count}</span>
    </div>
  );
}

function Pagination({ page, pages, onChange }: { page: number; pages: number; onChange: (p: number) => void }) {
  const nums = pageWindow(page, pages);
  const base =
    "min-w-8 rounded-md px-2.5 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand-500";
  const arrow = `${base} text-slate-500 hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent`;
  return (
    <div className="flex items-center justify-center gap-1">
      <button onClick={() => onChange(page - 1)} disabled={page === 1} aria-label="Назад" className={arrow}>
        <IconChevronLeft size={16} stroke={2} />
      </button>
      {nums.map((n, i) =>
        n === 0 ? (
          <span key={`gap-${i}`} className="px-1 text-slate-400">
            …
          </span>
        ) : (
          <button
            key={n}
            onClick={() => onChange(n)}
            aria-current={n === page ? "page" : undefined}
            className={`${base} ${
              n === page ? "bg-brand-600 font-medium text-on-accent" : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            {n}
          </button>
        ),
      )}
      <button onClick={() => onChange(page + 1)} disabled={page === pages} aria-label="Вперёд" className={arrow}>
        <IconChevronRight size={16} stroke={2} />
      </button>
    </div>
  );
}

function pageWindow(page: number, pages: number): number[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const out: number[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(pages - 1, page + 1);
  if (start > 2) out.push(0);
  for (let i = start; i <= end; i++) out.push(i);
  if (end < pages - 1) out.push(0);
  out.push(pages);
  return out;
}

const MR_ACTION: Record<string, { label: string; Icon: TablerIcon; tint: string }> = {
  create: { label: "Создание сервиса", Icon: IconGitBranch, tint: "indigo" },
  update: { label: "Обновление", Icon: IconGitCommit, tint: "blue" },
  delete: { label: "Удаление", Icon: IconTrash, tint: "rose" },
};

const MR_STATUS: Record<string, { label: string; className: string; Icon: TablerIcon }> = {
  opened: { label: "Открыт", className: "bg-amber-100 text-amber-800", Icon: IconGitPullRequest },
  merged: { label: "Влит", className: "bg-indigo-100 text-indigo-800", Icon: IconGitMerge },
  closed: { label: "Закрыт", className: "bg-slate-200 text-slate-600", Icon: IconGitPullRequestClosed },
};

function MergeRequestsCard({ mrs }: { mrs: RequestMR[] }) {
  const [showAll, setShowAll] = useState(false);
  return (
    <Card>
      <SectionHeader Icon={IconGitMerge} title="Запросы на слияние" count={mrs.length} />
      {mrs.length === 0 ? (
        <EmptyHint>Запросов на слияние пока нет.</EmptyHint>
      ) : (
        <ul className="flex flex-col gap-2">
          {mrs.slice(0, TL_PREVIEW).map((m) => (
            <MrRow key={m.id} m={m} />
          ))}
        </ul>
      )}
      {mrs.length > TL_PREVIEW && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-1 inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-brand-600 outline-none hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          Показать все ({mrs.length})
        </button>
      )}
      <MergeRequestsModal mrs={mrs} isOpen={showAll} onOpenChange={setShowAll} />
    </Card>
  );
}

function MergeRequestsModal({
  mrs,
  isOpen,
  onOpenChange,
}: {
  mrs: RequestMR[];
  isOpen: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [page, setPage] = useState(1);
  useEffect(() => {
    if (isOpen) setPage(1);
  }, [isOpen]);
  const pages = Math.max(1, Math.ceil(mrs.length / MODAL_PAGE));
  const slice = mrs.slice((page - 1) * MODAL_PAGE, page * MODAL_PAGE);
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 entering:animate-in entering:fade-in"
    >
      <Modal className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg bg-surface shadow-xl outline-none entering:animate-in entering:zoom-in-95">
        <Dialog className="flex max-h-[85vh] flex-col outline-none">
          {({ close }) => (
            <>
              <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
                <SectionHeaderInline Icon={IconGitMerge} title="Запросы на слияние" count={mrs.length} />
                <button
                  onClick={close}
                  aria-label="Закрыть"
                  className="rounded-md p-1 text-slate-400 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <IconX size={18} stroke={2} />
                </button>
              </header>
              <div className="flex-1 overflow-y-auto px-5 py-4">
                <ul className="flex flex-col gap-2">
                  {slice.map((m) => (
                    <MrRow key={m.id} m={m} />
                  ))}
                </ul>
              </div>
              {pages > 1 && (
                <footer className="border-t border-slate-200 px-5 py-3">
                  <Pagination page={page} pages={pages} onChange={setPage} />
                </footer>
              )}
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function MrRow({ m }: { m: RequestMR }) {
  const a = MR_ACTION[m.action] ?? { label: m.action, Icon: IconGitCommit, tint: "slate" };
  const s =
    MR_STATUS[m.mr_status] ?? { label: m.mr_status, className: "bg-slate-100 text-slate-600", Icon: IconGitPullRequest };
  return (
    <li>
      <a
        href={safeHref(m.mr_url)}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 outline-none transition-colors hover:border-brand-300 hover:bg-brand-50/50 focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${tints[a.tint]}`}>
          <a.Icon size={16} stroke={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-slate-800">{a.label}</span>
            <span className="shrink-0 text-xs text-slate-400">!{m.mr_iid}</span>
          </div>
          <div className="text-xs text-slate-400" title={fmtDateTime(m.created_at)}>
            {fmtRelative(m.created_at)}
          </div>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${s.className}`}>
          <s.Icon size={12} stroke={2} />
          {s.label}
        </span>
        <IconExternalLink
          size={16}
          stroke={1.8}
          className="shrink-0 text-slate-300 transition-colors group-hover:text-brand-500"
        />
      </a>
    </li>
  );
}
