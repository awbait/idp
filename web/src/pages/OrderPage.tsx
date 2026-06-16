import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import yaml from "js-yaml";
import { api, HttpError } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { useUser } from "../auth/UserContext";
import { useTeam } from "../app/TeamContext";
import { Button, Card, ErrorBox, Spinner } from "../components/ui";
import { FormErrors } from "../components/FormErrors";
import { NotFound } from "../components/NotFound";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { OrderMetaCard, OrderValuesCard } from "../components/OrderFormParts";
import { chartLabel, findCatalogChart, useCatalog } from "../app/CatalogContext";
import { isNewer, upgradeTargets } from "../lib/semver";
import type { ChangelogEntry, FieldError } from "../api/types";
import { pruneEmpty, collectErrors } from "../form/SchemaForm";

type Values = Record<string, unknown>;

// readPointer resolves a JSON Pointer (e.g. "/gateways/0/name") to a string.
// Used to source the deploy identity (service_name) from a values field that a
// view declares via "identity" — so the backend stays chart-agnostic.
function readPointer(obj: unknown, pointer: string): string {
  let cur: unknown = obj;
  for (const part of pointer.split("/").filter(Boolean)) {
    if (cur == null || typeof cur !== "object") return "";
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur == null ? "" : String(cur);
}

// OrderPage drives ordering a new service (/catalog/:project/:name/order),
// editing an existing DRAFT (/requests/:id/edit), and upgrading a live order to
// a newer chart version (/requests/:id/upgrade?to=X — the upgrade flag). Upgrade
// reuses the form at the target version (prefilled from the order) and opens an
// update MR; identity/cluster/namespace are immutable once deployed.
export function OrderPage({ upgrade = false }: { upgrade?: boolean }) {
  const { project: pParam = "", name: nParam = "", id } = useParams();
  const [searchParams] = useSearchParams();
  // Целевая версия апгрейда из ?to= (благословлённая версия); запасной вариант —
  // последняя версия чарта.
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
    () => (id ? api.getRequest(id) : Promise.resolve(null)),
    [id],
  );
  const draft = existing?.request ?? null;

  const project = editing ? draft?.chart_project ?? "" : pParam;
  const name = editing ? draft?.chart_name ?? "" : nParam;
  // Friendly product label (e.g. "Ingress Gateway") for the title and the
  // pre-filled display name; derived from the chart name.
  const label = name ? chartLabel(name) : "";

  const { data: chart, error: chartErr, loading: chartLoading } = useAsync(
    () => (project && name ? api.getChart(project, name) : Promise.resolve(null)),
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
  const [mode, setMode] = useState<"form" | "raw">("form");
  const [values, setValues] = useState<Values>({});
  const [raw, setRaw] = useState("");
  const [submitErr, setSubmitErr] = useState<{ message: string; details?: FieldError[] } | null>(null);
  const [busy, setBusy] = useState<null | "draft" | "submit">(null);
  // Reveal all client-side validation errors (set on a submit attempt); before
  // that, a field's error shows only once it's been touched.
  const [showErrors, setShowErrors] = useState(false);

  // Upgrade: целевая версия строго из ?to= (без подмены на latest, иначе можно
  // было бы «обновиться» на произвольную версию). Draft: закреплённая версия.
  // Новый заказ: последняя версия чарта.
  const targetVersion = upgrade ? upgradeToParam : "";
  // Допустимые версии апгрейда для этого заказа (выше текущей, не выше
  // согласованной). По ним валидируем ?to=, чтобы нельзя было открыть форму на
  // несуществующей/недопустимой версии.
  const approvedVersion = findCatalogChart(charts, project, name)?.publication?.approved_view_version;
  const allowedUpgrades = upgrade
    ? upgradeTargets(chart?.versions ?? [], draft?.chart_version ?? "", approvedVersion)
    : [];
  const effectiveVersion = upgrade
    ? targetVersion || null
    : editing
      ? draft?.chart_version ?? null
      : chart?.latest_version ?? null;

  // Апгрейд: CHANGELOG чарта между текущей версией заказа и целевой, чтобы было
  // видно, что изменилось.
  const { data: changelog } = useAsync(
    async () => {
      if (!upgrade || !project || !name) return [] as ChangelogEntry[];
      const all = await api.getAggregatedChangelog(project, name).catch(() => [] as ChangelogEntry[]);
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
    async () => {
      if (!project || !name || !effectiveVersion) return null;
      const schema = await api.getSchema(project, name, effectiveVersion);
      const ui = await api.getChartView(project, name).catch(() => null);
      return { schema, view: ui?.views?.order };
    },
    [project, name, effectiveVersion],
  );
  const schema = form?.schema ?? null;
  const orderView = form?.view;
  // A view may declare which values field supplies the deploy identity
  // (service_name). When set, we source the name from the form instead of a
  // separate "Service name" input — e.g. the gateway's own name field.
  const identity: string | undefined = orderView?.identity;
  const identityName = identity ? readPointer(values, identity) : "";

  // Client-side validation of the form values against the schema (required /
  // pattern / minLength / minItems), honoring the order view. Recomputed live so
  // red highlights clear as the user fixes fields. Empty in raw mode.
  const clientErrors = useMemo(
    () => (mode === "form" && schema ? collectErrors(schema, values, orderView) : new Map<string, string>()),
    [mode, schema, values, orderView],
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
    // page (the upgrade flow is the one exception — it edits a live order).
    navigate(`/requests/${draft.id}`, { replace: true });
    return null;
  }
  if (chartLoading) return <Spinner />;
  if (chartErr) return <ErrorBox error={chartErr} />;
  if (!chart) return null;

  // Upgrade guard: ждём каталог (источник допустимых версий), затем сверяем ?to=.
  // Недопустимая/несуществующая целевая версия не открывает форму обновления.
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

  if (!user || user.teams.length === 0) {
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
    const svcName = identity ? readPointer(finalValues, identity) : serviceName;
    return { values: finalValues, svcName };
  }

  function fail(e: unknown) {
    if (e instanceof HttpError) setSubmitErr({ message: e.message, details: e.details });
    else setSubmitErr({ message: (e as Error).message });
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
      setSubmitErr({ message: identity ? "Укажите имя Gateway в форме" : "Укажите имя сервиса" });
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

  // doUpgrade обновляет живой заказ до целевой версии: валидирует значения по
  // новой схеме и открывает update-MR (api.updateRequest с новой version). Имя
  // сервиса/кластер/namespace неизменны — отправляем только версию и values.
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
            кластер и namespace при обновлении не меняются — правятся только значения под новую схему.
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
          latest={!editing}
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
      />

      {submitErr && (
        <FormErrors
          message={submitErr.message}
          details={submitErr.details}
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
