import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import Editor from "@monaco-editor/react";
import yaml from "js-yaml";
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
import {
  IconArrowRight,
  IconCheck,
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
import { api, HttpError } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { canModify, useUser } from "../auth/UserContext";
import { Card, ErrorBox, Spinner } from "../components/ui";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StatusBadge, statusMeta } from "../components/StatusBadge";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { ProductIcon } from "../components/icons";
import { chartLabel } from "../app/CatalogContext";
import { PRODUCT_TABS } from "../components/products/registry";
import { SchemaForm, pruneEmpty, type View } from "../form/SchemaForm";
import type { RequestDetail, RequestEvent, RequestMR } from "../api/types";

export function RequestDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useUser();
  const { data, error, loading, reload } = useAsync(() => api.getRequest(id), [id]);

  // Inline rename of the cosmetic display name (pencil in the header).
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pulling, setPulling] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editingName) nameInputRef.current?.focus();
  }, [editingName]);

  // Live updates via SSE; reconnect handled by the browser.
  useEffect(() => {
    const es = new EventSource(`/api/v1/requests/${encodeURIComponent(id)}/events`);
    const onChange = () => reload();
    es.addEventListener("status_changed", onChange);
    return () => {
      es.removeEventListener("status_changed", onChange);
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (loading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const r = data.request;
  const mrs = data.merge_requests ?? [];
  const events = data.events ?? [];
  const modifiable = canModify(user, r.team) && r.status !== "DELETED";
  const isDraft = r.status === "DRAFT";
  // Two flavours of drift: the manifests were removed from Git (nothing to pull —
  // offer delete) vs. their values/version changed (offer pull). The detail text
  // is produced by our own drift reconciler, so matching it is stable enough.
  const driftMissing = r.drifted && /отсутству/i.test(r.drift_detail ?? "");

  async function onConfirmDelete() {
    await api.deleteRequest(id);
    isDraft ? navigate("/requests") : reload();
  }
  function startRename() {
    setNameDraft(r.display_name || "");
    setEditingName(true);
  }
  async function saveName() {
    setSavingName(true);
    try {
      await api.renameRequest(id, nameDraft.trim());
      setEditingName(false);
      reload();
    } catch (e) {
      alert(e instanceof HttpError ? e.message : (e as Error).message);
    } finally {
      setSavingName(false);
    }
  }
  async function onSubmit() {
    try {
      await api.submitRequest(id);
      reload();
    } catch (e) {
      alert(e instanceof HttpError ? e.message : (e as Error).message);
    }
  }
  async function onSync() {
    try {
      await api.syncRequest(id);
      alert("Sync requested");
    } catch (e) {
      alert(e instanceof HttpError ? e.message : (e as Error).message);
    }
  }
  async function onPull() {
    setPulling(true);
    try {
      await api.pullRequest(id);
      reload();
    } catch (e) {
      alert(e instanceof HttpError ? e.message : (e as Error).message);
    } finally {
      setPulling(false);
    }
  }

  const productTabs = PRODUCT_TABS[r.chart_name] ?? [];
  // Persist the open tab in the URL (?tab=) so it survives live reloads (SSE),
  // page refresh and back/forward. Falls back to "info" for unknown values.
  const tabIds = ["info", ...productTabs.map((t) => t.id), "history"];
  const requestedTab = searchParams.get("tab") ?? "";
  const activeTab = tabIds.includes(requestedTab) ? requestedTab : "info";
  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs
        items={[
          {
            label: chartLabel(r.chart_name),
            to: `/products/${r.chart_project}/${r.chart_name}`,
          },
          { label: r.service_name },
        ]}
      />
      {r.imported && (
        <div className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
          <IconGitFork size={18} stroke={1.8} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Импортировано из Git</p>
            <p className="mt-0.5 text-sky-700">
              Этот сервис создан в Git вне портала и подхвачен автоматически.
            </p>
          </div>
        </div>
      )}
      {r.drifted && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="flex items-start gap-2">
            <IconAlertTriangle size={18} stroke={1.8} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">
                {driftMissing ? "Манифесты удалены из Git" : "Изменено в Git вне портала"}
              </p>
              <p className="mt-0.5 text-amber-700">
                {driftMissing
                  ? `${r.drift_detail} — подтягивать нечего, сервис можно удалить из портала.`
                  : r.drift_detail || "Состояние в Git расходится с тем, что хранит портал."}
              </p>
            </div>
          </div>
          {modifiable &&
            (driftMissing ? (
              <button
                onClick={() => setConfirmDelete(true)}
                title="Удалить заказ из портала (в Git его уже нет)"
                className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 outline-none hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                <IconTrash size={14} stroke={1.8} />
                Удалить из портала
              </button>
            ) : (
              <button
                onClick={onPull}
                disabled={pulling}
                title="Затянуть текущее состояние из Git в портал"
                className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 outline-none hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50"
              >
                <IconRefresh size={14} stroke={1.8} />
                {pulling ? "Подтягиваем…" : "Подтянуть из Git"}
              </button>
            ))}
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
            <ProductIcon name={r.chart_name} size={22} />
          </span>
          {editingName ? (
            <div className="flex items-center gap-1.5">
              <input
                ref={nameInputRef}
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveName();
                  if (e.key === "Escape") setEditingName(false);
                }}
                placeholder={r.service_name}
                disabled={savingName}
                className="rounded-md border border-gray-300 px-2 py-1 text-xl font-semibold outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
              />
              <button
                onClick={saveName}
                disabled={savingName}
                aria-label="Сохранить имя"
                className="rounded-md p-1.5 text-emerald-600 outline-none hover:bg-emerald-50 focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
              >
                <IconCheck size={18} stroke={2} />
              </button>
              <button
                onClick={() => setEditingName(false)}
                disabled={savingName}
                aria-label="Отмена"
                className="rounded-md p-1.5 text-slate-400 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
              >
                <IconX size={18} stroke={2} />
              </button>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-xl font-semibold">{r.display_name || r.service_name}</h1>
              {modifiable && (
                <button
                  onClick={startRename}
                  aria-label="Изменить отображаемое имя"
                  className="shrink-0 rounded-md p-1 text-slate-400 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <IconPencil size={16} stroke={1.8} />
                </button>
              )}
            </div>
          )}
        </div>
        <DetailActions
          isDraft={isDraft}
          onContinue={isDraft && modifiable ? () => navigate(`/requests/${r.id}/edit`) : undefined}
          onSubmit={isDraft && modifiable ? onSubmit : undefined}
          onSync={!isDraft && user?.role === "admin" ? onSync : undefined}
          onDelete={modifiable ? () => setConfirmDelete(true) : undefined}
        />
      </div>

      <ConfirmDialog
        isOpen={confirmDelete}
        onOpenChange={setConfirmDelete}
        danger
        title={isDraft ? "Удалить черновик?" : "Удалить сервис?"}
        confirmLabel="Удалить"
        busyLabel="Удаляем…"
        message={
          isDraft ? (
            <>
              Черновик «{r.display_name || r.service_name}» будет удалён без возможности
              восстановления.
            </>
          ) : (
            <>Для сервиса «{r.service_name}» будет открыт merge request на удаление.</>
          )
        }
        onConfirm={onConfirmDelete}
      />

      {/* Creator / created-at / status strip; status is last and right-aligned. */}
      <Card className="grid grid-cols-3 gap-4">
        <Meta label="Создатель">
          <span className="text-sm text-gray-800">{r.created_by_name || "—"}</span>
        </Meta>
        <Meta label="Создан">
          <span className="text-sm text-gray-800">{fmtDateTime(r.created_at)}</span>
        </Meta>
        <Meta label="Статус">
          <StatusBadge status={r.status} />
        </Meta>
      </Card>

      <Tabs
        selectedKey={activeTab}
        onSelectionChange={(key) =>
          setSearchParams(
            (p) => {
              p.set("tab", String(key));
              return p;
            },
            { replace: true },
          )
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200">
          <TabList aria-label="Разделы заказа" className="flex gap-1">
            <DetailTab id="info">Общая информация</DetailTab>
            {productTabs.map((t) => (
              <DetailTab key={t.id} id={t.id}>
                {t.label}
              </DetailTab>
            ))}
            <DetailTab id="history">История действий</DetailTab>
          </TabList>
          <ValuesModalButton request={r} />
        </div>

        <TabPanel id="info" className="pt-5 outline-none">
          <InfoTab request={r} argocdUrl={data.argocd_url} modifiable={modifiable} onChanged={reload} />
        </TabPanel>
        {productTabs.map((t) => (
          <TabPanel key={t.id} id={t.id} className="pt-5 outline-none">
            <Card>
              <t.Component request={r} modifiable={modifiable} reload={reload} />
            </Card>
          </TabPanel>
        ))}
        <TabPanel id="history" className="pt-5 outline-none">
          <HistoryTab events={events} mrs={mrs} />
        </TabPanel>
      </Tabs>
    </div>
  );
}

function Meta({
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
function DetailTab({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <Tab
      id={id}
      className="-mb-px cursor-pointer border-b-2 border-transparent px-3 py-2 text-sm font-medium text-gray-500 outline-none transition-colors hover:text-gray-700 selected:border-brand-600 selected:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      {children}
    </Tab>
  );
}

function InfoTab({
  request: r,
  argocdUrl,
  modifiable,
  onChanged,
}: {
  request: RequestDetail["request"];
  argocdUrl?: string;
  modifiable: boolean;
  onChanged: () => void;
}) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-700">Общая информация</h2>
        {modifiable && <InfoActions request={r} onChanged={onChanged} />}
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

// InfoActions is the "Действия" dropdown inside the Info tab; currently exposes
// editing the Gateway istio-proxy CPU/memory resources (hidden from the order
// form). Editing live order values opens an update MR via the backend.
function InfoActions({ request: r, onChanged }: { request: RequestDetail["request"]; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  // The resources editor is declared as a "resources" view in the chart's
  // approved view document (same place as the order/routes views). No view ->
  // no action (charts without one don't get the menu).
  const { data: resourcesView } = useAsync(
    () =>
      api
        .getChartView(r.chart_project, r.chart_name)
        .then((j) => j?.views?.resources ?? null)
        .catch(() => null),
    [r.chart_project, r.chart_name],
  );
  if (!resourcesView) return null;
  const item = "cursor-pointer px-3 py-1.5 text-sm text-slate-700 outline-none focus:bg-slate-50";
  return (
    <>
      <MenuTrigger>
        <AriaButton className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-brand-200 bg-white px-3 py-1.5 text-sm font-medium text-brand-600 outline-none hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-500">
          <IconDotsVertical size={16} stroke={1.8} className="text-brand-600" />
          Действия
        </AriaButton>
        <Popover className="min-w-56 rounded-md border border-slate-200 bg-white py-1 shadow-lg outline-none entering:animate-in entering:fade-in">
          <Menu className="outline-none" onAction={(k) => k === "resources" && setEditing(true)}>
            <MenuItem id="resources" className={item}>
              Редактировать ресурсы (CPU/память)
            </MenuItem>
          </Menu>
        </Popover>
      </MenuTrigger>
      <ResourcesModal request={r} view={resourcesView} isOpen={editing} onOpenChange={setEditing} onChanged={onChanged} />
    </>
  );
}

// ResourcesModal edits gateways[0].resources with a SCHEMA + VIEW driven form:
// it fetches the chart's values.schema.json and renders it through the chart's
// "resources" view (declared in the chart's view document), so the fields stay in sync with
// the schema and the projection lives declaratively alongside the order/routes views.
function ResourcesModal({
  request: r,
  view,
  isOpen,
  onOpenChange,
  onChanged,
}: {
  request: RequestDetail["request"];
  view: View;
  isOpen: boolean;
  onOpenChange: (v: boolean) => void;
  onChanged: () => void;
}) {
  // Fetch the schema lazily (only while open).
  const { data: schema, loading: schemaLoading, error: schemaErr } = useAsync(
    () => (isOpen ? api.getSchema(r.chart_project, r.chart_name, r.chart_version) : Promise.resolve(null)),
    [isOpen, r.chart_project, r.chart_name, r.chart_version],
  );

  // Form value is shaped to the view (gateways[0].resources). Seeded from current
  // values (or chart defaults) each time the modal opens.
  const [value, setValue] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cur: unknown;
    try {
      cur = (yaml.load(r.values_yaml) as any)?.gateways?.[0]?.resources;
    } catch {
      cur = undefined;
    }
    const fallback = {
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "2000m", memory: "1024Mi" },
    };
    const resources = (cur && typeof cur === "object" ? cur : fallback) as Record<string, unknown>;
    setValue({ gateways: [{ resources }] });
    setErr(null);
  }, [isOpen, r.values_yaml]);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const values = ((yaml.load(r.values_yaml) as Record<string, any>) ?? {}) as Record<string, any>;
      if (!Array.isArray(values.gateways) || !values.gateways[0]) {
        throw new Error("В values нет Gateway — нечего редактировать.");
      }
      const edited = (pruneEmpty(value).gateways as any)?.[0]?.resources;
      values.gateways[0].resources = edited; // undefined -> falls back to chart default
      await api.updateRequest(r.id, { values });
      onOpenChange(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof HttpError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 entering:animate-in entering:fade-in"
    >
      <Modal className="w-full max-w-md rounded-lg bg-white shadow-xl outline-none entering:animate-in entering:zoom-in-95">
        <Dialog className="outline-none">
          {({ close }) => (
            <div className="flex flex-col">
              <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
                <h2 className="text-sm font-semibold text-gray-700">Ресурсы Gateway (istio-proxy)</h2>
                <button
                  onClick={close}
                  aria-label="Закрыть"
                  className="rounded-md p-1 text-gray-400 outline-none hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  <IconX size={18} stroke={2} />
                </button>
              </header>
              <div className="flex flex-col gap-3 px-4 py-4">
                {schemaErr ? (
                  <p className="text-xs text-red-600">Не удалось загрузить схему: {schemaErr.message}</p>
                ) : !schema || schemaLoading ? (
                  <Spinner label="Загрузка схемы…" />
                ) : (
                  <SchemaForm schema={schema} value={value} onChange={setValue} view={view} />
                )}
                <p className="text-xs text-gray-500">
                  Изменение откроет merge request (для активного сервиса) с обновлёнными values.
                </p>
                {err && <p className="text-xs text-red-600">{err}</p>}
              </div>
              <footer className="flex justify-end gap-2 border-t border-gray-200 px-4 py-3">
                <button
                  onClick={close}
                  disabled={saving}
                  className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 outline-none hover:bg-gray-50 disabled:opacity-50"
                >
                  Отмена
                </button>
                <button
                  onClick={save}
                  disabled={saving || !schema}
                  className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white outline-none hover:bg-brand-700 disabled:opacity-50"
                >
                  {saving ? "Сохраняем…" : "Сохранить"}
                </button>
              </footer>
            </div>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

// ---- История действий: «Хронология» (timeline) + «Запросы на слияние» (MRs) ----

type TablerIcon = typeof IconHistory;

const TL_PREVIEW = 5; // events shown inline before "show all"
const MODAL_PAGE = 10; // events per page in the modal

// Soft icon-circle tints, keyed by name so the maps below stay readable.
const tints: Record<string, string> = {
  slate: "bg-slate-100 text-slate-600",
  indigo: "bg-indigo-100 text-indigo-600",
  blue: "bg-blue-100 text-blue-600",
  rose: "bg-rose-100 text-rose-600",
  amber: "bg-amber-100 text-amber-700",
  emerald: "bg-emerald-100 text-emerald-600",
  sky: "bg-sky-100 text-sky-600",
};

// Presentation for non-status events. status_changed is special-cased (it borrows
// the target status's icon/colour from statusMeta).
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

function HistoryTab({
  events,
  mrs,
}: {
  events: NonNullable<RequestDetail["events"]>;
  mrs: NonNullable<RequestDetail["merge_requests"]>;
}) {
  // Newest first: events by their sequential id, MRs by creation time.
  const evts = [...events].sort((a, b) => b.id - a.id);
  const mrList = [...mrs].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
  // Two columns when there's room (lg+), stacked on narrow screens. items-start
  // so the cards keep their own height instead of stretching to match.
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
      {/* connector rail (hidden on the last node) */}
      {!last && <span className="absolute bottom-0 left-[15px] top-8 w-px bg-slate-200" aria-hidden />}
      <span className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-4 ring-white ${circle}`}>
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
      <Modal className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg bg-white shadow-xl outline-none entering:animate-in entering:zoom-in-95">
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

// Like SectionHeader but without the bottom margin (for the modal header row).
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
              n === page ? "bg-brand-600 font-medium text-white" : "text-slate-600 hover:bg-slate-100"
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

// pageWindow returns the page numbers to render, with 0 marking an ellipsis gap.
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
      <Modal className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg bg-white shadow-xl outline-none entering:animate-in entering:zoom-in-95">
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
        href={m.mr_url}
        target="_blank"
        rel="noreferrer"
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

// ValuesModalButton opens the read-only values.yaml in a centered modal.
function ValuesModalButton({ request: r }: { request: RequestDetail["request"] }) {
  return (
    <DialogTrigger>
      <AriaButton className="mb-2 inline-flex shrink-0 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-brand-500">
        <IconFileCode size={16} stroke={1.8} className="text-gray-400" />
        values.yaml
      </AriaButton>
      <ModalOverlay className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 entering:animate-in entering:fade-in">
        <Modal className="w-full max-w-3xl rounded-lg bg-white shadow-xl outline-none entering:animate-in entering:zoom-in-95">
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

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// fmtRelative renders a compact "X ago" label (abbreviations dodge RU plural
// forms); falls back to the absolute date past a week. Full date is in title=.
function fmtRelative(iso: string): string {
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

// DetailActions is the header's "Действия" dropdown (vertical dots). It renders
// only the actions available for the current order/role; nothing if there are none.
function DetailActions({
  isDraft,
  onContinue,
  onSubmit,
  onSync,
  onDelete,
}: {
  isDraft: boolean;
  onContinue?: () => void;
  onSubmit?: () => void;
  onSync?: () => void;
  onDelete?: () => void;
}) {
  if (!onContinue && !onSubmit && !onSync && !onDelete) return null;
  const item = "cursor-pointer px-3 py-1.5 text-sm text-slate-700 outline-none focus:bg-slate-50";
  return (
    <MenuTrigger>
      <AriaButton className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-brand-200 bg-white px-3 py-1.5 text-sm font-medium text-brand-600 outline-none hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-500">
        <IconDotsVertical size={16} stroke={1.8} className="text-brand-600" />
        Действия
      </AriaButton>
      <Popover className="min-w-48 rounded-md border border-slate-200 bg-white py-1 shadow-lg outline-none entering:animate-in entering:fade-in">
        <Menu
          className="outline-none"
          onAction={(key) => {
            if (key === "continue") onContinue?.();
            else if (key === "submit") onSubmit?.();
            else if (key === "sync") onSync?.();
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

function Field({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div>
      <div className="text-xs uppercase text-gray-400">{label}</div>
      {href && value ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="group inline-flex items-center gap-1 text-brand-600 hover:text-brand-700 hover:underline"
        >
          {value}
          <IconExternalLink size={14} stroke={1.8} className="text-brand-400 group-hover:text-brand-600" />
        </a>
      ) : (
        <div className="text-gray-800">{value || "—"}</div>
      )}
    </div>
  );
}
