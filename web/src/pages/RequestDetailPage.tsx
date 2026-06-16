// RequestDetailPage: the product (order) detail page. Fully schema + view driven:
// the Info-tab "Действия" and the product tabs are derived from the chart's view
// document (genericView/GenericProductTabs), so it is chart-agnostic - no per-chart
// code. Presentational pieces live in ./requestDetailParts.
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  IconArrowUpCircle,
  IconCheck,
  IconAlertTriangle,
  IconGitFork,
  IconPencil,
  IconRefresh,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { TabList, TabPanel, Tabs } from "react-aria-components";
import { api, HttpError } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { canModify, useUser } from "../auth/UserContext";
import { Card, ErrorBox, Spinner } from "../components/ui";
import { NotFound } from "../components/NotFound";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StatusBadge } from "../components/StatusBadge";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { ProductIcon } from "../components/icons";
import { chartLabel, findCatalogChart, useCatalog } from "../app/CatalogContext";
import { isNewer } from "../lib/semver";
import { productTabs } from "../components/products/genericView";
import { GenericInfoActions, GenericListTab } from "../components/products/GenericProductTabs";
import {
  DetailActions,
  DetailTab,
  Field,
  fmtDateTime,
  HistoryTab,
  Meta,
  ValuesModalButton,
} from "./requestDetailParts";
import type { RequestDetail, ViewDocument } from "../api/types";

export function RequestDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useUser();
  const { charts } = useCatalog();
  const { data, error, loading, reload } = useAsync(() => api.getRequest(id), [id]);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pulling, setPulling] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editingName) nameInputRef.current?.focus();
  }, [editingName]);

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
  if (error instanceof HttpError && error.status === 404)
    return (
      <NotFound
        title="Заказ не найден"
        message="Заказ удалён или такого идентификатора не существует."
        backTo="/requests"
        backLabel="К моим заказам"
      />
    );
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const r = data.request;
  const mrs = data.merge_requests ?? [];
  const events = data.events ?? [];
  const modifiable = canModify(user, r.team) && r.status !== "DELETED";
  const isDraft = r.status === "DRAFT";
  const driftMissing = r.drifted && /отсутству/i.test(r.drift_detail ?? "");

  const pub = findCatalogChart(charts, r.chart_project, r.chart_name)?.publication;
  const liveStatus = ["MR_MERGED", "DEPLOYING", "HEALTHY", "DEGRADED", "ARGO_MISSING"].includes(r.status);
  const upgradeTo =
    pub?.approved_view_version && isNewer(pub.approved_view_version, r.chart_version)
      ? pub.approved_view_version
      : null;
  const canUpgrade = modifiable && !isDraft && liveStatus && !!upgradeTo && !r.drifted;

  async function onConfirmDelete() {
    await api.deleteRequest(id);
    isDraft ? navigate("/requests") : reload();
  }
  function startRename() {
    setNameDraft(r.display_name || "");
    setEditingName(true);
  }
  async function saveName() {
    if (nameDraft.trim() === (r.display_name || "")) {
      setEditingName(false);
      return;
    }
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

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs
        items={[
          { label: chartLabel(r.chart_name), to: `/products/${r.chart_project}/${r.chart_name}` },
          { label: r.service_name },
        ]}
      />
      {r.imported && (
        <div className="flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
          <IconGitFork size={18} stroke={1.8} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Импортировано из Git</p>
            <p className="mt-0.5 text-sky-700">Этот сервис создан в Git вне портала и подхвачен автоматически.</p>
          </div>
        </div>
      )}
      {r.drifted && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="flex items-start gap-2">
            <IconAlertTriangle size={18} stroke={1.8} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">{driftMissing ? "Манифесты удалены из Git" : "Изменено в Git вне портала"}</p>
              <p className="mt-0.5 text-amber-700">
                {driftMissing
                  ? `${r.drift_detail}. Подтягивать нечего, сервис можно удалить из портала.`
                  : r.drift_detail || "Состояние в Git расходится с тем, что хранит портал."}
              </p>
            </div>
          </div>
          {modifiable &&
            (driftMissing ? (
              <button
                onClick={() => setConfirmDelete(true)}
                title="Удалить заказ из портала (в Git его уже нет)"
                className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-surface px-3 py-1.5 text-xs font-medium text-amber-800 outline-none hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                <IconTrash size={14} stroke={1.8} />
                Удалить из портала
              </button>
            ) : (
              <button
                onClick={onPull}
                disabled={pulling}
                title="Затянуть текущее состояние из Git в портал"
                className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-surface px-3 py-1.5 text-xs font-medium text-amber-800 outline-none hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50"
              >
                <IconRefresh size={14} stroke={1.8} />
                {pulling ? "Подтягиваем…" : "Подтянуть из Git"}
              </button>
            ))}
        </div>
      )}
      {canUpgrade && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
          <div className="flex items-start gap-2">
            <IconArrowUpCircle size={18} stroke={1.8} className="mt-0.5 shrink-0 text-brand-600" />
            <div>
              <p className="font-medium">Доступно обновление: версия {upgradeTo}</p>
              <p className="mt-0.5 text-brand-700">
                Заказ развёрнут на версии {r.chart_version}. Автор согласовал форму для {upgradeTo} - откройте форму
                на новой версии, проверьте значения и обновите.
              </p>
            </div>
          </div>
          <Link
            to={`/requests/${id}/upgrade?to=${encodeURIComponent(upgradeTo!)}`}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-on-accent outline-none hover:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <IconArrowUpCircle size={14} stroke={1.8} />
            Обновить до {upgradeTo}
          </Link>
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
                disabled={savingName || nameDraft.trim() === (r.display_name || "")}
                aria-label="Сохранить имя"
                className="rounded-md p-1.5 text-emerald-600 outline-none hover:bg-emerald-50 focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
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
            <>Черновик «{r.display_name || r.service_name}» будет удалён без возможности восстановления.</>
          ) : (
            <>Для сервиса «{r.service_name}» будет открыт merge request на удаление.</>
          )
        }
        onConfirm={onConfirmDelete}
      />

      <Card className="grid grid-cols-3 gap-4">
        <Meta label="Создатель">
          <span className="text-sm text-gray-800">{r.created_by_name || "-"}</span>
        </Meta>
        <Meta label="Создан">
          <span className="text-sm text-gray-800">{fmtDateTime(r.created_at)}</span>
        </Meta>
        <Meta label="Статус">
          <StatusBadge status={r.status} />
        </Meta>
      </Card>

      <ProductTabs
        request={r}
        events={events}
        mrs={mrs}
        argocdUrl={data.argocd_url}
        modifiable={modifiable}
        reload={reload}
        activeTab={searchParams.get("tab") ?? ""}
        onTab={(key) =>
          setSearchParams(
            (p) => {
              p.set("tab", key);
              return p;
            },
            { replace: true },
          )
        }
      />
    </div>
  );
}

// ProductTabs builds the tab strip from the chart's view document: Общая
// информация, one tab per product view, История действий.
function ProductTabs({
  request: r,
  events,
  mrs,
  argocdUrl,
  modifiable,
  reload,
  activeTab,
  onTab,
}: {
  request: RequestDetail["request"];
  events: NonNullable<RequestDetail["events"]>;
  mrs: NonNullable<RequestDetail["merge_requests"]>;
  argocdUrl?: string;
  modifiable: boolean;
  reload: () => void;
  activeTab: string;
  onTab: (key: string) => void;
}) {
  const { data: doc } = useAsync<ViewDocument | null>(
    () => api.getChartView(r.chart_project, r.chart_name),
    [r.chart_project, r.chart_name],
  );
  const view = doc ?? { views: {} };
  const tabs = productTabs(view);
  const tabIds = ["info", ...tabs.map((t) => t.id), "history"];
  const active = tabIds.includes(activeTab) ? activeTab : "info";

  return (
    <Tabs selectedKey={active} onSelectionChange={(key) => onTab(String(key))}>
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
          doc={view}
          onChanged={reload}
        />
      </TabPanel>
      {tabs.map((t) => (
        <TabPanel key={t.id} id={t.id} className="pt-5 outline-none">
          <Card>
            <GenericListTab request={r} modifiable={modifiable} reload={reload} doc={view} tab={t} />
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
}: {
  request: RequestDetail["request"];
  argocdUrl?: string;
  modifiable: boolean;
  doc: ViewDocument;
  onChanged: () => void;
}) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-700">Общая информация</h2>
        {modifiable && <GenericInfoActions request={r} doc={doc} onChanged={onChanged} />}
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
