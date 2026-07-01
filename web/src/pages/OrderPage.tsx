import yaml from "js-yaml";
import { useEffect, useMemo, useRef, useState } from "react";
import { TabList, TabPanel, Tabs } from "react-aria-components";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, HttpError } from "../api/client";
import type { ChangelogEntry, FieldError, OrderRequest, ViewDocument } from "../api/types";
import { chartLabel, findCatalogChart, useCatalog } from "../app/CatalogContext";
import { useTeam } from "../app/TeamContext";
import { useUser } from "../auth/UserContext";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { FormErrors } from "../components/FormErrors";
import { NotFound } from "../components/NotFound";
import { OrderMetaCard, OrderValuesCard } from "../components/OrderFormParts";
import {
  GenericInfoActions,
  GenericListTab,
  type PersistValues,
} from "../components/products/GenericProductTabs";
import { actionViews, productTabs } from "../components/products/genericView";
import { Button, Card, ErrorBox, Spinner } from "../components/ui";
import { collectErrors, pruneEmpty } from "../form/SchemaForm";
import { useAsync } from "../hooks/useAsync";
import { isNewer, upgradeTargets, upgradeTargetsFromAllowlist } from "../lib/semver";
import { DetailTab } from "./requestDetailParts";

type Values = Record<string, unknown>;

// readPointer resolves a JSON Pointer (e.g. "/gateways/0/name") to a string.
// Used to source the deploy identity (service_name) from a values field that a
// view declares via "identity" - so the backend stays chart-agnostic.
function readPointer(obj: unknown, pointer: string): string {
  let cur: unknown = obj;
  for (const part of pointer.split("/").filter(Boolean)) {
    if (cur == null || typeof cur !== "object") return "";
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur == null ? "" : String(cur);
}

// writePointer returns a copy of obj with value set at an object JSON Pointer
// (e.g. "/namespace/namespaceName"), creating intermediate objects. Used to
// mirror the order's destination namespace into the values field a view binds
// via "namespace" - matching the backend, which stamps the same field. Numeric
// segments are not addressed (object fields only, like the backend setPointer).
function writePointer(obj: Values, pointer: string, value: string): Values {
  const parts = pointer.split("/").filter(Boolean);
  if (parts.length === 0) return obj;
  const root: Values = { ...obj };
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cur[parts[i]];
    const clone: Record<string, unknown> =
      next != null && typeof next === "object" && !Array.isArray(next)
        ? { ...(next as Record<string, unknown>) }
        : {};
    cur[parts[i]] = clone;
    cur = clone;
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}

// OrderPage drives ordering a new service (/catalog/:project/:name/order),
// editing an existing DRAFT (/requests/:id/edit), and upgrading a live order to
// a newer chart version (/requests/:id/upgrade?to=X - the upgrade flag). Upgrade
// reuses the form at the target version (prefilled from the order) and opens an
// update MR; identity/cluster/namespace are immutable once deployed.
export function OrderPage({ upgrade = false }: { upgrade?: boolean }) {
  const { project: pParam = "", name: nParam = "", id } = useParams();
  const [searchParams] = useSearchParams();
  // Upgrade target version from ?to= (the approved version); fallback is the
  // chart's latest version.
  const upgradeToParam = searchParams.get("to") ?? "";
  const editing = !!id;
  const navigate = useNavigate();
  const { user } = useUser();
  // Team is chosen globally (topbar); the order form doesn't ask for it.
  const { team: activeTeam } = useTeam();
  const { charts, loading: catalogLoading } = useCatalog();

  // In edit mode, load the draft we're continuing. Its chart coordinates and
  // pinned version drive the rest of the page.
  const { data: existing, error: existingErr, loading: existingLoading } = useAsync(
    (signal) => (id ? api.getRequest(id, signal) : Promise.resolve(null)),
    [id],
  );
  const draft = existing?.request ?? null;

  const project = editing ? draft?.chart_project ?? "" : pParam;
  const name = editing ? draft?.chart_name ?? "" : nParam;
  // Friendly product label (e.g. "Ingress Gateway") for the title and the
  // pre-filled display name; derived from the chart name.
  const label = name ? chartLabel(name) : "";

  const { data: chart, error: chartErr, loading: chartLoading } = useAsync(
    (signal) => (project && name ? api.getChart(project, name, signal) : Promise.resolve(null)),
    [project, name],
  );

  const [serviceName, setServiceName] = useState("");
  // Pre-fill the display name with the product's friendly label (e.g. "Ingress
  // Gateway"); user can edit or clear it (empty falls back to service_name).
  // In edit mode it's hydrated from the draft below.
  const [displayName, setDisplayName] = useState(() => (id ? "" : nParam ? chartLabel(nParam) : ""));
  // ArgoCD destination: cluster (default in-cluster) + target namespace.
  const [cluster, setCluster] = useState("in-cluster");
  const [namespace, setNamespace] = useState("");
  // New-order chart version: defaults to the recommended (or highest orderable)
  // version once the catalog loads; the user can switch it (initialized below).
  const [selectedVersion, setSelectedVersion] = useState("");
  const [mode, setMode] = useState<"form" | "raw">("form");
  const [values, setValues] = useState<Values>({});
  const [raw, setRaw] = useState("");
  const [submitErr, setSubmitErr] = useState<{ message: string; details?: FieldError[] } | null>(null);
  const [busy, setBusy] = useState<null | "draft" | "submit">(null);
  // Reveal all client-side validation errors (set on a submit attempt); before
  // that, a field's error shows only once it's been touched.
  const [showErrors, setShowErrors] = useState(false);

  // Upgrade: target version strictly from ?to= (no fallback to latest, else one
  // could "upgrade" to an arbitrary version). Draft: the pinned version.
  // New order: the chart's latest version.
  const targetVersion = upgrade ? upgradeToParam : "";
  // Publication overlay: the allowlist of orderable versions + the recommended
  // default (multi-version publications). Empty for legacy single-view charts.
  const pub = findCatalogChart(charts, project, name)?.publication;
  const orderableVersions = pub?.orderable_versions ?? [];
  const recommendedVersion = pub?.recommended_version ?? "";
  // Allowed upgrade versions for this order (newer than current). From the
  // orderable allowlist when available, else the legacy approved-version
  // heuristic. We validate ?to= against them so the form can't open on a
  // missing/disallowed version.
  const allowedUpgrades = !upgrade
    ? []
    : orderableVersions.length > 0
      ? upgradeTargetsFromAllowlist(orderableVersions, draft?.chart_version ?? "")
      : upgradeTargets(chart?.versions ?? [], draft?.chart_version ?? "", pub?.approved_view_version);
  const effectiveVersion = upgrade
    ? targetVersion || null
    : editing
      ? draft?.chart_version ?? null
      : selectedVersion || null;

  // Initialize the new-order version once the catalog/publication is known:
  // recommended, else the highest orderable, else the chart's latest version.
  useEffect(() => {
    if (editing || upgrade || selectedVersion) return;
    const def = recommendedVersion || orderableVersions[0] || chart?.latest_version || "";
    if (def) setSelectedVersion(def);
  }, [editing, upgrade, selectedVersion, recommendedVersion, orderableVersions, chart?.latest_version]);

  // Upgrade: the chart's CHANGELOG between the order's current version and the
  // target, so the changes are visible.
  const { data: changelog } = useAsync(
    async (signal) => {
      if (!upgrade || !project || !name) return [] as ChangelogEntry[];
      const all = await api
        .getAggregatedChangelog(project, name, 20, signal)
        .catch(() => [] as ChangelogEntry[]);
      const from = draft?.chart_version ?? "";
      return all.filter((e) => isNewer(e.version, from) && !isNewer(e.version, targetVersion));
    },
    [upgrade, project, name, draft?.chart_version, targetVersion],
  );

  // Load the schema (from the chart, via the API) plus the chart's approved
  // view document (from its publication). The "order" view curates the form
  // (e.g. one Gateway, hide xroutes); the schema stays the single source of
  // truth for validation.
  const { data: form } = useAsync(
    async (signal) => {
      if (!project || !name || !effectiveVersion) return null;
      const schema = await api.getSchema(project, name, effectiveVersion, signal);
      // Request the view for the selected version only when it is an orderable
      // version; otherwise (legacy charts) fall back to the default active view.
      const viewVersion = orderableVersions.includes(effectiveVersion) ? effectiveVersion : undefined;
      const ui = await api.getChartView(project, name, viewVersion, signal).catch(() => null);
      return { schema, doc: ui, view: ui?.views?.order };
    },
    [project, name, effectiveVersion, orderableVersions.join(",")],
  );
  const schema = form?.schema ?? null;
  const orderView = form?.view;
  const viewDoc = form?.doc ?? null;
  // A view may declare which values field supplies the deploy identity
  // (service_name). When set, we source the name from the form instead of a
  // separate "Service name" input - e.g. the gateway's own name field.
  const identity: string | undefined = orderView?.identity;
  // A view may bind destination.namespace to a values field for a chart that
  // provisions its own namespace (managed-namespace): the single "Namespace"
  // input is mirrored into that field (which is hidden in the form), so the chart
  // renders into the namespace it creates. The backend stamps the same field.
  const nsBinding: string | undefined = orderView?.namespace;
  // Values with the namespace binding applied - used for validation, identity and
  // submission so the bound (hidden) field is populated from the Namespace input.
  const effectiveValues = useMemo(
    () => (nsBinding && namespace ? writePointer(values, nsBinding, namespace) : values),
    [values, nsBinding, namespace],
  );
  const identityName = identity ? readPointer(effectiveValues, identity) : "";

  // Client-side validation of the form values against the schema (required /
  // pattern / minLength / minItems), honoring the order view. Recomputed live so
  // red highlights clear as the user fixes fields. Empty in raw mode.
  const clientErrors = useMemo(
    () => (mode === "form" && schema ? collectErrors(schema, effectiveValues, orderView) : new Map<string, string>()),
    [mode, schema, effectiveValues, orderView],
  );

  // Hydrate the form from the draft once (edit mode only).
  const hydrated = useRef(false);
  useEffect(() => {
    if (!editing || hydrated.current || !draft) return;
    setServiceName(draft.service_name);
    setDisplayName(draft.display_name);
    if (draft.cluster) setCluster(draft.cluster);
    if (draft.namespace) setNamespace(draft.namespace);
    try {
      setValues((yaml.load(draft.values_yaml) as Values) ?? {});
    } catch {
      setValues({});
    }
    hydrated.current = true;
  }, [editing, draft]);

  if (editing && existingLoading) return <Spinner />;
  if (editing && existingErr) return <ErrorBox error={existingErr} />;
  if (editing && !upgrade && draft && draft.status !== "DRAFT") {
    // Only drafts are editable here; live orders bounce to the read-only detail
    // page (the upgrade flow is the one exception - it edits a live order).
    // Use <Navigate> rather than calling navigate() during render (which warns in
    // React 19/StrictMode and can double-navigate).
    return <Navigate to={`/requests/${draft.id}`} replace />;
  }
  if (chartLoading) return <Spinner />;
  if (chartErr) return <ErrorBox error={chartErr} />;
  if (!chart) return null;

  // Upgrade guard: wait for the catalog (source of allowed versions), then check
  // ?to=. A disallowed/missing target version won't open the upgrade form.
  if (upgrade) {
    if (catalogLoading) return <Spinner />;
    if (!targetVersion || !allowedUpgrades.includes(targetVersion)) {
      return (
        <NotFound
          title="Обновление недоступно"
          message="Этой версии для обновления не существует или она не разрешена."
          backTo={id ? `/requests/${id}` : "/requests"}
          backLabel="К заказу"
        />
      );
    }
  }

  if (!user || (user.teams?.length ?? 0) === 0) {
    return (
      <Card>
        <p className="text-sm text-gray-600">
          You need to be a member of a team (group <code>team-*</code>) to order services.
        </p>
      </Card>
    );
  }

  function switchMode(next: "form" | "raw") {
    if (next === mode) return;
    if (next === "raw") {
      setRaw(yaml.dump(pruneEmpty(values)));
    } else {
      try {
        setValues((yaml.load(raw) as Values) ?? {});
      } catch {
        /* keep previous form values if YAML is invalid */
      }
    }
    setMode(next);
  }

  // collectValues resolves the values + deploy identity from the active editor
  // (form or raw YAML); returns null and sets an error when invalid.
  function collectValues(): { values: Values; svcName: string } | null {
    let finalValues: Values = {};
    try {
      finalValues = mode === "raw" ? ((yaml.load(raw) as Values) ?? {}) : pruneEmpty(values);
    } catch (e) {
      setSubmitErr({ message: "Невалидный YAML: " + (e as Error).message });
      return null;
    }
    // Mirror the destination namespace into the bound (hidden) field so the sent
    // values match what the backend stamps; covers raw mode too.
    if (nsBinding && namespace) finalValues = writePointer(finalValues, nsBinding, namespace);
    const svcName = identity ? readPointer(finalValues, identity) : serviceName;
    return { values: finalValues, svcName };
  }

  function fail(e: unknown) {
    if (e instanceof HttpError) {
      // An open MR blocks the change: explain it in Russian instead of the bare
      // English domain string. The order page itself links to the MR.
      const message =
        e.code === "open_mr"
          ? `Уже открыт запрос на слияние${e.mrIid ? ` #${e.mrIid}` : ""} для этого сервиса. Дождитесь его обработки или закройте его, прежде чем вносить новые изменения.`
          : e.message;
      setSubmitErr({ message, details: e.details });
    } else setSubmitErr({ message: (e as Error).message });
  }

  // saveDraft persists the in-progress order without opening an MR.
  async function saveDraft() {
    setSubmitErr(null);
    const c = collectValues();
    if (!c) return;
    setBusy("draft");
    try {
      if (editing) {
        await api.updateRequest(id!, {
          service_name: c.svcName || undefined,
          display_name: displayName || undefined,
          cluster: cluster || undefined,
          namespace: namespace || undefined,
          values: c.values,
        });
      } else {
        await api.createRequest({
          chart: `${project}/${name}`,
          version: effectiveVersion!,
          team: activeTeam!,
          service_name: c.svcName,
          display_name: displayName || undefined,
          cluster: cluster || undefined,
          namespace: namespace || undefined,
          values: c.values,
          draft: true,
        });
      }
      // Back to the product page (its orders list), where the new draft shows on top.
      navigate(project && name ? `/products/${project}/${name}` : "/requests");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  // submit finalises the order: it opens the create MR. For a draft we persist
  // the latest edits first, then submit.
  async function submit() {
    setSubmitErr(null);
    // Client-side validation first: highlight every invalid field in red and stop.
    if (clientErrors.size > 0) {
      setShowErrors(true);
      setSubmitErr({ message: "Заполните обязательные поля, отмеченные красным." });
      return;
    }
    const c = collectValues();
    if (!c) return;
    if (!c.svcName) {
      setShowErrors(true);
      setSubmitErr({ message: identity ? "Укажите идентификатор в форме" : "Укажите имя сервиса" });
      return;
    }
    if (!cluster || !namespace) {
      setShowErrors(true);
      setSubmitErr({ message: "Укажите кластер и namespace." });
      return;
    }
    setBusy("submit");
    try {
      let req;
      if (editing) {
        // Persist the latest edits, then finalise (opens the create MR).
        await api.updateRequest(id!, {
          service_name: c.svcName,
          display_name: displayName || undefined,
          cluster,
          namespace,
          values: c.values,
        });
        req = await api.submitRequest(id!);
      } else {
        // Direct order: create and open the MR in one shot.
        req = await api.createRequest({
          chart: `${project}/${name}`,
          version: effectiveVersion!,
          team: activeTeam!,
          service_name: c.svcName,
          display_name: displayName || undefined,
          cluster,
          namespace,
          values: c.values,
        });
      }
      navigate(`/requests/${req.id}`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  // doUpgrade upgrades a live order to the target version: validates the values
  // against the new schema and opens an update MR (api.updateRequest with the new
  // version). Service name/cluster/namespace are immutable - we send only the
  // version and values.
  async function doUpgrade() {
    setSubmitErr(null);
    if (clientErrors.size > 0) {
      setShowErrors(true);
      setSubmitErr({ message: "Заполните обязательные поля, отмеченные красным." });
      return;
    }
    const c = collectValues();
    if (!c) return;
    setBusy("submit");
    try {
      await api.updateRequest(id!, { version: targetVersion, values: c.values });
      navigate(`/requests/${id}`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  const submitting = busy !== null;

  return (
    <div className="flex flex-col gap-4 pb-8">
      <Breadcrumbs
        items={[
          {
            label: label || `${chart.project}/${chart.name}`,
            to: `/products/${project}/${name}`,
          },
          ...(editing
            ? [
                { label: draft?.service_name || "черновик", to: `/requests/${id}` },
                { label: upgrade ? "Обновление" : "Редактирование" },
              ]
            : [{ label: "Новый заказ" }]),
        ]}
      />
      <h1 className="text-xl font-semibold">
        {upgrade ? "Обновление: " : editing ? "Черновик: " : "Заказ "}
        {label || `${chart.project}/${chart.name}`}
        {upgrade && (
          <span className="text-gray-400">
            {" "}
            {draft?.chart_version} → {targetVersion}
          </span>
        )}
      </h1>

      {upgrade ? (
        <Card className="flex flex-col gap-3">
          <p className="text-sm text-gray-600">
            Сервис <span className="font-medium text-gray-800">{draft?.service_name}</span> · команда{" "}
            <span className="font-medium text-gray-800">{draft?.team}</span> · кластер{" "}
            <span className="font-medium text-gray-800">{draft?.cluster}</span> · namespace{" "}
            <span className="font-medium text-gray-800">{draft?.namespace}</span>
          </p>
          <p className="text-sm text-gray-600">
            Версия <span className="font-medium text-gray-800">{draft?.chart_version}</span> →{" "}
            <span className="font-medium text-brand-700">{targetVersion}</span>. Идентификатор,
            кластер и namespace при обновлении не меняются - правятся только значения под новую схему.
          </p>
          {changelog && changelog.length > 0 && (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
              <p className="mb-1.5 font-semibold text-slate-700">Что изменилось в чарте</p>
              <div className="flex flex-col gap-2">
                {changelog.map((e) => (
                  <div key={e.version}>
                    <p className="font-medium text-slate-700">
                      {e.version}
                      {e.date && <span className="ml-1.5 font-normal text-slate-400">{e.date}</span>}
                    </p>
                    {Object.entries(e.sections).map(([sec, items]) => (
                      <div key={sec} className="ml-1 mt-0.5">
                        <span className="uppercase text-slate-400">{sec}:</span>{" "}
                        <span className="text-slate-600">{items.join("; ")}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      ) : (
        <OrderMetaCard
          identity={identity}
          displayName={displayName}
          onDisplayName={setDisplayName}
          serviceName={serviceName}
          onServiceName={setServiceName}
          cluster={cluster}
          onCluster={setCluster}
          namespace={namespace}
          onNamespace={setNamespace}
          team={editing ? draft?.team : activeTeam ?? undefined}
          version={effectiveVersion ?? undefined}
          latest={!editing && orderableVersions.length === 0}
          versions={editing ? undefined : orderableVersions}
          onVersion={editing ? undefined : setSelectedVersion}
          recommendedVersion={recommendedVersion}
          identityName={identityName}
          showErrors={showErrors}
        />
      )}

      <OrderValuesCard
        schema={schema}
        view={orderView}
        values={values}
        onValues={setValues}
        mode={mode}
        onSwitchMode={switchMode}
        raw={raw}
        onRaw={setRaw}
        errors={clientErrors}
        showErrors={showErrors}
        lockReadOnly={upgrade}
        lockedPaths={upgrade && identity ? [identity] : undefined}
      />

      {/* On upgrade, let the other sections be edited too (tabs + actions), like
          on the product page, but into the same values and as a single MR. */}
      {upgrade && schema && viewDoc && draft && (
        <UpgradeExtras
          request={{ ...draft, chart_version: targetVersion, values_yaml: yaml.dump(pruneEmpty(values)) }}
          doc={viewDoc}
          schema={schema as Record<string, any>}
          onValues={setValues}
        />
      )}

      {submitErr && (
        <FormErrors
          message={submitErr.message}
          details={submitErr.details}
          fieldErrors={showErrors && clientErrors.size > 0 ? clientErrors : undefined}
          schema={schema ?? undefined}
          view={orderView}
        />
      )}

      <div className="flex gap-2">
        {upgrade ? (
          <Button
            variant="primary"
            isDisabled={submitting || !targetVersion}
            onPress={doUpgrade}
          >
            {busy === "submit" ? "Обновляем…" : `Обновить до ${targetVersion}`}
          </Button>
        ) : (
          <>
            <Button
              variant="primary"
              isDisabled={submitting || !effectiveVersion || (!editing && !activeTeam)}
              onPress={submit}
            >
              {busy === "submit" ? "Заказываем…" : "Заказать"}
            </Button>
            <Button variant="secondary" isDisabled={submitting || !effectiveVersion} onPress={saveDraft}>
              {busy === "draft" ? "Сохраняем…" : "Сохранить черновик"}
            </Button>
          </>
        )}
        <Button variant="secondary" isDisabled={submitting} onPress={() => navigate(-1)}>
          Отмена
        </Button>
      </div>
    </div>
  );
}

// UpgradeExtras renders the product's other sections (list tabs + the info-menu
// actions) on the upgrade page, so listeners/routes/resources can be edited too,
// not just the order form. It edits the same local values via persist (no API)
// and reuses the exact product-page components, so it matches the live page; the
// whole thing is submitted as one upgrade MR by the parent.
function UpgradeExtras({
  request,
  doc,
  schema,
  onValues,
}: {
  request: OrderRequest;
  doc: ViewDocument;
  schema: Record<string, any>;
  onValues: (v: Values) => void;
}) {
  const tabs = productTabs(doc);
  const persist: PersistValues = (v) => onValues(v as Values);
  const hasInfoActions = actionViews(doc, "info").some((a) => doc.views?.[a.view]);
  if (tabs.length === 0 && !hasInfoActions) return null;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-700">Конфигурация</h2>
        <GenericInfoActions
          request={request}
          doc={doc}
          onChanged={() => {}}
          schema={schema}
          persist={persist}
        />
      </div>
      {tabs.length > 0 && (
        <Tabs>
          <TabList aria-label="Разделы" className="flex gap-1 border-b border-gray-200">
            {tabs.map((t) => (
              <DetailTab key={t.id} id={t.id}>
                {t.title ?? t.id}
              </DetailTab>
            ))}
          </TabList>
          {tabs.map((t) => (
            <TabPanel key={t.id} id={t.id} className="pt-4 outline-none">
              <GenericListTab
                request={request}
                modifiable
                reload={() => {}}
                doc={doc}
                tab={t}
                schema={schema}
                persist={persist}
              />
            </TabPanel>
          ))}
        </Tabs>
      )}
    </Card>
  );
}
