// RequestDetailPage: the product (order) detail page. Fully schema + view driven:
// the Info-tab actions and the product tabs are derived from the chart's view
// document (genericView/GenericProductTabs), so it is chart-agnostic - no per-chart
// code. Presentational pieces live in ./requestDetailParts.

import {
  IconAlertTriangle,
  IconArrowUpCircle,
  IconCheck,
  IconGitFork,
  IconGitPullRequest,
  IconPencil,
  IconRefresh,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, errorMessage, HttpError } from "../api/client";
import type { ViewDocument } from "../api/types";
import { chartLabel, findCatalogChart, useCatalog } from "../app/CatalogContext";
import { useTeam } from "../app/TeamContext";
import { useToast } from "../app/ToastContext";
import { canEditOrder, canModify, useUser } from "../auth/UserContext";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ProductIcon } from "../components/icons";
import { NotFound } from "../components/NotFound";
import { StatusBadge } from "../components/StatusBadge";
import { Button, Card, Select, Spinner } from "../components/ui";
import { useAsync } from "../hooks/useAsync";
import { safeHref } from "../lib/href";
import { upgradeTargets } from "../lib/semver";
import { attachSseLogger } from "../lib/sse";
import { DetailActions, fmtDateTime, Meta, ProductView } from "./requestDetailParts";

// Message for the "open MR blocks this change" conflict (proactive banner and
// the delete race), kept consistent across both call sites.
function openMRBlockedText(iid?: number): string {
  return `Уже открыт запрос на слияние${iid ? ` #${iid}` : ""} для этого сервиса. Дождитесь его обработки или закройте его, прежде чем вносить новые изменения.`;
}

export function RequestDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useUser();
  const { team } = useTeam();
  const { charts } = useCatalog();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => api.getRequest(id), [id]);
  // The chart's approved view document drives the product tabs/actions. Loaded
  // here (was inside the tabs) so ProductView stays presentational.
  const { data: viewDoc } = useAsync<ViewDocument | null>(
    () =>
      data
        ? api.getChartView(data.request.chart_project, data.request.chart_name)
        : Promise.resolve(null),
    [data?.request.chart_project, data?.request.chart_name],
  );

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  // "Upgrade available" is shown once per order: localStorage holds the version
  // at which the nudge was dismissed; a new target version shows it again. Keyed
  // by order id (id is available immediately, before data loads).
  const [upgradeDismissed, setUpgradeDismissed] = useState<string | null>(() => {
    try {
      return localStorage.getItem(`order-upgrade-nudge:${id}`);
    } catch {
      return null;
    }
  });
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editingName) nameInputRef.current?.focus();
  }, [editingName]);

  useEffect(() => {
    const es = new EventSource(`/api/v1/requests/${encodeURIComponent(id)}/events`);
    attachSseLogger(es, "order");
    const onChange = () => reload();
    es.addEventListener("status_changed", onChange);
    return () => {
      es.removeEventListener("status_changed", onChange);
      es.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // The active team (topbar) scopes what the user is working on, like the orders
  // list. If they switch it to a team that does not own this order, the order is no
  // longer in context, so leave for the (now team-scoped) orders list. Only a
  // user-initiated switch after load bounces: a direct link opened while another
  // team is active is left alone (we record the team on first load, not bounce on
  // it). Access itself stays membership-based on the backend - this is UX scoping.
  const prevTeam = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    prevTeam.current = undefined;
  }, [id]);
  useEffect(() => {
    if (!data || team == null) return;
    const orderTeam = data.request.team;
    if (prevTeam.current === undefined) {
      prevTeam.current = team;
      return;
    }
    if (team === prevTeam.current) return;
    prevTeam.current = team;
    if (user?.teams?.includes(orderTeam) && team !== orderTeam) {
      navigate("/requests", { replace: true });
    }
  }, [team, data, user, navigate]);

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
  if (error instanceof HttpError && error.status === 403)
    return (
      <NotFound
        title="Нет доступа к заказу"
        message="Заказ принадлежит другой команде. Переключите команду в шапке или вернитесь к своим заказам."
        backTo="/requests"
        backLabel="К моим заказам"
      />
    );
  if (error) return <LoadError error={error} onRetry={reload} />;
  if (!data) return null;

  const r = data.request;
  const mrs = data.merge_requests ?? [];
  const events = data.events ?? [];
  // An open MR blocks any new change (edit/upgrade/delete) - the backend rejects
  // it with 409 open_mr. Surface it up front so we can disable those actions and
  // point at the MR instead of letting the user hit the error.
  const openMR = mrs.find((m) => m.mr_status === "opened") ?? null;
  // modifiable: provision-class affordances (create/delete) - owner or admin.
  // editable: value/rename/upgrade affordances - also support, across teams.
  const modifiable = canModify(user, r.team) && r.status !== "DELETED";
  const editable = canEditOrder(user, r.team) && r.status !== "DELETED";
  const isDraft = r.status === "DRAFT";
  const driftMissing = r.drifted && /отсутству/i.test(r.drift_detail ?? "");

  const catalogChart = findCatalogChart(charts, r.chart_project, r.chart_name);
  const pub = catalogChart?.publication;
  const liveStatus = ["MR_MERGED", "DEPLOYING", "HEALTHY", "DEGRADED", "ARGO_MISSING"].includes(r.status);
  // Allowed upgrade versions: above current and not above the author-approved one.
  // The single source of truth (it also validates ?to= on the order page).
  const upgradeVersions = upgradeTargets(
    catalogChart?.versions ?? [],
    r.chart_version,
    pub?.approved_view_version,
  );
  const upgradeTo = upgradeVersions[0] ?? null; // recommended (approved) version
  const canUpgrade =
    editable && !isDraft && liveStatus && upgradeVersions.length > 0 && !r.drifted && !openMR;
  const showUpgradeNudge = canUpgrade && upgradeDismissed !== upgradeTo;

  function dismissUpgradeNudge() {
    setUpgradeDismissed(upgradeTo);
    try {
      if (upgradeTo) localStorage.setItem(`order-upgrade-nudge:${id}`, upgradeTo);
    } catch {
      /* no localStorage - that's fine, we just won't remember the dismissal */
    }
  }

  async function onConfirmDelete() {
    try {
      await api.deleteRequest(id);
      isDraft ? navigate("/requests") : reload();
    } catch (e) {
      // Race: an MR may have opened between load and confirm. Show the blocked
      // reason in Russian (ConfirmDialog renders a thrown message inline).
      if (e instanceof HttpError && e.code === "open_mr") {
        throw new Error(openMRBlockedText(e.mrIid));
      }
      throw e;
    }
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
      toast.error(errorMessage(e));
    } finally {
      setSavingName(false);
    }
  }
  async function onSubmit() {
    try {
      await api.submitRequest(id);
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  async function onSync() {
    try {
      await api.syncRequest(id);
      toast.success("Выкатка из Git запущена");
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }
  async function onPull() {
    setPulling(true);
    try {
      await api.pullRequest(id);
      reload();
    } catch (e) {
      toast.error(errorMessage(e));
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
          {driftMissing
            ? modifiable && (
              <button
                onClick={() => setConfirmDelete(true)}
                title="Удалить заказ из портала (в Git его уже нет)"
                className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-surface px-3 py-1.5 text-xs font-medium text-amber-800 outline-none hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-500"
              >
                <IconTrash size={14} stroke={1.8} />
                Удалить из портала
              </button>
            )
            : editable && (
              <button
                onClick={onPull}
                disabled={pulling}
                title="Затянуть текущее состояние из Git в портал"
                className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-surface px-3 py-1.5 text-xs font-medium text-amber-800 outline-none hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-50"
              >
                <IconRefresh size={14} stroke={1.8} />
                {pulling ? "Подтягиваем…" : "Подтянуть из Git"}
              </button>
            )}
        </div>
      )}
      {openMR && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="flex items-start gap-2">
            <IconGitPullRequest size={18} stroke={1.8} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Открыт запрос на слияние{openMR.mr_iid ? ` #${openMR.mr_iid}` : ""}</p>
              <p className="mt-0.5 text-amber-700">
                Пока он не обработан, изменение, обновление и удаление сервиса недоступны.
              </p>
            </div>
          </div>
          {safeHref(openMR.mr_url) && (
            <a
              href={safeHref(openMR.mr_url)}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-surface px-3 py-1.5 text-xs font-medium text-amber-800 outline-none hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              <IconGitPullRequest size={14} stroke={1.8} />
              Открыть MR
            </a>
          )}
        </div>
      )}
      {showUpgradeNudge && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
          <div className="flex items-center gap-2">
            <IconArrowUpCircle size={18} stroke={1.8} className="shrink-0 text-brand-600" />
            <p className="font-medium">Доступно обновление продукта до версии {upgradeTo}</p>
          </div>
          <button
            onClick={dismissUpgradeNudge}
            aria-label="Скрыть"
            className="shrink-0 rounded-md p-1 text-brand-400 outline-none hover:bg-brand-100 hover:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <IconX size={16} stroke={2} />
          </button>
        </div>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
            <ProductIcon project={r.chart_project} name={r.chart_name} size={22} />
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
              {editable && (
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
          onUpgrade={canUpgrade ? () => setUpgradeOpen(true) : undefined}
          onSync={!isDraft && user?.role === "admin" ? onSync : undefined}
          onDelete={modifiable && !openMR ? () => setConfirmDelete(true) : undefined}
          notify={canUpgrade}
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
            <>Черновик <strong>{r.display_name || r.service_name}</strong> будет удалён без возможности восстановления.</>
          ) : (
            <>Сервис <strong>{r.service_name}</strong> будет удалён.</>
          )
        }
        onConfirm={onConfirmDelete}
      />

      <UpgradeDialog
        isOpen={upgradeOpen}
        onOpenChange={setUpgradeOpen}
        currentVersion={r.chart_version}
        versions={upgradeVersions}
        onConfirm={(to) => navigate(`/requests/${r.id}/upgrade?to=${encodeURIComponent(to)}`)}
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

      <ProductView
        request={r}
        doc={viewDoc ?? { views: {} }}
        events={events}
        mrs={mrs}
        argocdUrl={data.argocd_url}
        modifiable={editable}
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

// LoadError is the friendly fallback for an unexpected load failure that is not a
// 404/403 (those have their own NotFound states) - e.g. the backend is
// unreachable, returns 5xx, or the order lives in a store the running portal is
// not connected to (in-memory portal vs an order persisted in Postgres). It keeps
// the technical detail visible for debugging instead of dumping a bare error code
// on the user, and offers a retry plus a way back.
function LoadError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const detail =
    error instanceof HttpError ? `${error.code} (HTTP ${error.status})` : error.message;
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-red-50 text-red-400">
        <IconAlertTriangle size={38} stroke={1.5} />
      </span>
      <div>
        <h1 className="text-lg font-semibold text-slate-800">Не удалось загрузить заказ</h1>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
          Бэкенд недоступен или вернул ошибку. Проверьте, что портал запущен и подключён к тому же
          хранилищу, где создан заказ.
        </p>
        <p className="mx-auto mt-2 max-w-md font-mono text-xs text-slate-400">{detail}</p>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" onPress={onRetry}>
          Повторить
        </Button>
        <Link
          to="/requests"
          className="inline-flex items-center rounded-md border border-gray-300 bg-surface px-4 py-2 text-sm font-medium text-gray-700 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          К моим заказам
        </Link>
      </div>
    </div>
  );
}

// UpgradeDialog lets the user pick the target version for an upgrade. Only the
// allowed versions (newer than current, up to the author-approved one) are
// offered, so it is impossible to open an upgrade to a missing/lower version.
function UpgradeDialog({
  isOpen,
  onOpenChange,
  currentVersion,
  versions,
  onConfirm,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  currentVersion: string;
  versions: string[];
  onConfirm: (to: string) => void;
}) {
  // Default to the newest allowed version (the author-approved one).
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (isOpen) setSelected(versions[0] ?? null);
  }, [isOpen, versions]);

  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 entering:animate-in entering:fade-in"
    >
      <Modal className="w-full max-w-md rounded-lg bg-surface shadow-xl outline-none entering:animate-in entering:zoom-in-95">
        <Dialog className="outline-none">
          {({ close }) => (
            <div className="flex flex-col gap-4 p-5">
              <div>
                <Heading slot="title" className="text-base font-semibold text-gray-900">
                  Обновление продукта
                </Heading>
                <p className="mt-1 text-sm text-gray-600">
                  Текущая версия: <span className="font-medium text-gray-800">{currentVersion}</span>.
                  Выберите версию для обновления.
                </p>
              </div>
              <Select
                label="Версия"
                isRequired
                selectedKey={selected}
                onSelectionChange={(k) => setSelected(k as string)}
                options={versions.map((v) => ({ id: v, label: v }))}
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={close}
                  className="rounded-md border border-gray-300 bg-surface px-3 py-1.5 text-sm font-medium text-gray-700 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  Отмена
                </button>
                <Button
                  variant="primary"
                  isDisabled={!selected}
                  onPress={() => selected && onConfirm(selected)}
                >
                  Обновить
                </Button>
              </div>
            </div>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
