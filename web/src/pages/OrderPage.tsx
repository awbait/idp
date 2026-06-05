import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Editor from "@monaco-editor/react";
import yaml from "js-yaml";
import { api, HttpError } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { useUser } from "../auth/UserContext";
import { useTeam } from "../app/TeamContext";
import { Button, Card, ErrorBox, Spinner, TextField } from "../components/ui";
import { FormErrors } from "../components/FormErrors";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { chartLabel } from "../app/CatalogContext";
import type { FieldError } from "../api/types";
import { SchemaForm, pruneEmpty, collectErrors } from "../form/SchemaForm";

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

// OrderPage drives both ordering a new service (/catalog/:project/:name/order)
// and editing an existing DRAFT (/requests/:id/edit). A draft can be saved for
// later ("Сохранить черновик") or finalised, which opens the MR ("Заказать").
export function OrderPage() {
  const { project: pParam = "", name: nParam = "", id } = useParams();
  const editing = !!id;
  const navigate = useNavigate();
  const { user } = useUser();
  // Team is chosen globally (topbar); the order form doesn't ask for it.
  const { team: activeTeam } = useTeam();

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

  // A draft keeps its pinned version; a new order always takes the latest.
  const effectiveVersion = editing ? draft?.chart_version ?? null : chart?.latest_version ?? null;

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
  if (editing && draft && draft.status !== "DRAFT") {
    // Only drafts are editable here; bounce to the read-only detail page.
    navigate(`/requests/${draft.id}`, { replace: true });
    return null;
  }
  if (chartLoading) return <Spinner />;
  if (chartErr) return <ErrorBox error={chartErr} />;
  if (!chart) return null;

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

  const submitting = busy !== null;

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumbs
        items={[
          {
            label: label || `${chart.project}/${chart.name}`,
            to: `/products/${project}/${name}`,
          },
          ...(editing
            ? [
                { label: draft?.service_name || "черновик", to: `/requests/${id}` },
                { label: "Редактирование" },
              ]
            : [{ label: "Новый заказ" }]),
        ]}
      />
      <h1 className="text-xl font-semibold">
        {editing ? "Черновик: " : "Заказ "}
        {label || `${chart.project}/${chart.name}`}
      </h1>

      <Card className="flex flex-col gap-3">
        <TextField
          label="Отображаемое имя"
          description="Произвольное имя для отображения. Можно изменить позже; на деплой не влияет."
          placeholder={identity ? "Напр. Public Gateway" : "payments-db"}
          value={displayName}
          onChange={setDisplayName}
        />
        {!identity && (
          <TextField
            label="Service name"
            isRequired
            placeholder="payments-db"
            value={serviceName}
            onChange={setServiceName}
            errorText={showErrors && !serviceName ? "Обязательное поле" : undefined}
          />
        )}
        <TextField
          label="Кластер"
          description="Кластер назначения ArgoCD (destination.name)."
          isRequired
          placeholder="in-cluster"
          value={cluster}
          onChange={setCluster}
          errorText={showErrors && !cluster ? "Обязательное поле" : undefined}
        />
        <TextField
          label="Namespace"
          description="Namespace назначения в кластере (destination.namespace)."
          isRequired
          placeholder="my-namespace"
          value={namespace}
          onChange={setNamespace}
          errorText={showErrors && !namespace ? "Обязательное поле" : undefined}
        />
        <p className="text-xs text-gray-500">
          Команда <span className="font-medium text-gray-700">{editing ? draft?.team : activeTeam}</span> · версия{" "}
          <span className="font-medium text-gray-700">{effectiveVersion}</span>
          {!editing && " (последняя)"}
          {identity && (
            <>
              {" "}· идентификатор:{" "}
              <span className="font-medium text-gray-700">{identityName || "—"}</span> (из имени Gateway)
            </>
          )}
        </p>
      </Card>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">Values</h2>
          <div className="flex gap-1 rounded-md bg-gray-100 p-0.5 text-xs">
            <button
              onClick={() => switchMode("form")}
              className={`rounded px-2 py-1 ${mode === "form" ? "bg-white shadow" : "text-gray-500"}`}
            >
              Form
            </button>
            <button
              onClick={() => switchMode("raw")}
              className={`rounded px-2 py-1 ${mode === "raw" ? "bg-white shadow" : "text-gray-500"}`}
            >
              Raw YAML
            </button>
          </div>
        </div>

        {mode === "form" ? (
          schema ? (
            <SchemaForm
              schema={schema}
              value={values}
              onChange={setValues}
              view={orderView}
              errors={clientErrors}
              showErrors={showErrors}
            />
          ) : (
            <p className="text-sm text-gray-500">
              No schema for this version — switch to Raw YAML.
            </p>
          )
        ) : (
          <div className="overflow-hidden rounded-md border border-gray-200">
            <Editor
              height="320px"
              defaultLanguage="yaml"
              value={raw}
              onChange={(v) => setRaw(v ?? "")}
              options={{ minimap: { enabled: false }, fontSize: 13, automaticLayout: true }}
            />
          </div>
        )}
      </Card>

      {submitErr && (
        <FormErrors
          message={submitErr.message}
          details={submitErr.details}
          schema={schema ?? undefined}
          view={orderView}
        />
      )}

      <div className="flex gap-2">
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
        <Button variant="secondary" isDisabled={submitting} onPress={() => navigate(-1)}>
          Отмена
        </Button>
      </div>
    </div>
  );
}
