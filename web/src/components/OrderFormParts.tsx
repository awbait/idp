// Presentational pieces of the order form (OrderPage), extracted so the
// chart-manage preview renders the exact same form a user sees when ordering:
// OrderMetaCard (display name / service name / cluster / namespace + summary)
// and OrderValuesCard (Form/Raw YAML toggle over the schema-driven form).
import Editor from "@monaco-editor/react";
import type { JSONSchema } from "../api/types";
import { useTheme } from "../app/ThemeContext";
import { SchemaForm, type View } from "../form/SchemaForm";
import { Card, Select, TextField } from "./ui";

type Values = Record<string, unknown>;

// OrderMetaCard holds the order's non-values fields. When the order view declares
// an identity field, the service name comes from the form, so the Service name
// input is hidden and the resolved identity is shown in the summary line instead.
export function OrderMetaCard({
  identity,
  displayName,
  onDisplayName,
  serviceName,
  onServiceName,
  cluster,
  onCluster,
  namespace,
  onNamespace,
  team,
  version,
  latest = false,
  versions,
  onVersion,
  recommendedVersion,
  identityName,
  showErrors = false,
}: {
  identity?: string;
  displayName: string;
  onDisplayName: (v: string) => void;
  serviceName: string;
  onServiceName: (v: string) => void;
  cluster: string;
  onCluster: (v: string) => void;
  namespace: string;
  onNamespace: (v: string) => void;
  team?: string;
  version?: string;
  latest?: boolean;
  // Orderable versions (allowlist) and a setter: when more than one is offered a
  // version dropdown is shown; otherwise the version is just printed below.
  versions?: string[];
  onVersion?: (v: string) => void;
  recommendedVersion?: string;
  identityName?: string;
  showErrors?: boolean;
}) {
  const showVersionSelect = !!onVersion && !!versions && versions.length > 1;
  return (
    <Card className="flex flex-col gap-3">
      <TextField
        label="Отображаемое имя"
        description="Произвольное имя для отображения. Можно изменить позже; на деплой не влияет."
        placeholder={identity ? "Напр. Production" : "payments-db"}
        value={displayName}
        onChange={onDisplayName}
      />
      {!identity && (
        <TextField
          label="Service name"
          isRequired
          placeholder="payments-db"
          value={serviceName}
          onChange={onServiceName}
          errorText={showErrors && !serviceName ? "Обязательное поле" : undefined}
        />
      )}
      <TextField
        label="Кластер"
        description="Кластер назначения ArgoCD (destination.name)."
        isRequired
        placeholder="in-cluster"
        value={cluster}
        onChange={onCluster}
        errorText={showErrors && !cluster ? "Обязательное поле" : undefined}
      />
      <TextField
        label="Namespace"
        description="Namespace назначения в кластере (destination.namespace)."
        isRequired
        placeholder="my-namespace"
        value={namespace}
        onChange={onNamespace}
        errorText={showErrors && !namespace ? "Обязательное поле" : undefined}
      />
      {showVersionSelect && (
        <Select
          label="Версия"
          description="Версия чарта для заказа."
          selectedKey={version ?? null}
          onSelectionChange={(v) => onVersion?.(v)}
          options={(versions ?? []).map((v) => ({
            id: v,
            label: v === recommendedVersion ? `${v} (рекомендуемая)` : v,
          }))}
        />
      )}
      <p className="text-xs text-gray-500">
        Команда <span className="font-medium text-gray-700">{team}</span> · версия{" "}
        <span className="font-medium text-gray-700">{version}</span>
        {latest && " (последняя)"}
        {!showVersionSelect && version === recommendedVersion && recommendedVersion && " (рекомендуемая)"}
        {identity && (
          <>
            {" "}· идентификатор:{" "}
            <span className="font-medium text-gray-700">{identityName || "-"}</span> (из формы)
          </>
        )}
      </p>
    </Card>
  );
}

// OrderValuesCard renders the chart values: a Form/Raw YAML toggle, the
// schema-driven form (the order view projection) or the raw YAML editor. Mode
// switching (which converts between form values and YAML) is owned by the parent
// via onSwitchMode, so the parent keeps a single source of truth for submit.
export function OrderValuesCard({
  schema,
  view,
  values,
  onValues,
  mode,
  onSwitchMode,
  raw,
  onRaw,
  errors,
  showErrors = false,
  lockReadOnly = false,
  lockedPaths,
}: {
  schema: JSONSchema | null;
  view?: View;
  values: Values;
  onValues: (v: Values) => void;
  mode: "form" | "raw";
  onSwitchMode: (next: "form" | "raw") => void;
  raw: string;
  onRaw: (s: string) => void;
  errors?: Map<string, string>;
  showErrors?: boolean;
  // Lock ui:readOnly fields (set on edit/upgrade of a live order).
  lockReadOnly?: boolean;
  // Always-locked field paths (e.g. the deploy identity on upgrade).
  lockedPaths?: string[];
}) {
  const { theme } = useTheme();
  const monacoTheme = theme === "light" ? "light" : "vs-dark";
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Values</h2>
        <div className="flex gap-1 rounded-md bg-gray-100 p-0.5 text-xs">
          <button
            onClick={() => onSwitchMode("form")}
            className={`rounded px-2 py-1 ${mode === "form" ? "bg-surface shadow" : "text-gray-500"}`}
          >
            Form
          </button>
          <button
            onClick={() => onSwitchMode("raw")}
            className={`rounded px-2 py-1 ${mode === "raw" ? "bg-surface shadow" : "text-gray-500"}`}
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
            onChange={onValues}
            view={view}
            errors={errors}
            showErrors={showErrors}
            lockReadOnly={lockReadOnly}
            lockedPaths={lockedPaths}
          />
        ) : (
          <p className="text-sm text-gray-500">No schema for this version - switch to Raw YAML.</p>
        )
      ) : (
        <div className="overflow-hidden rounded-md border border-gray-200">
          <Editor
            height="320px"
            defaultLanguage="yaml"
            theme={monacoTheme}
            value={raw}
            onChange={(v) => onRaw(v ?? "")}
            options={{ minimap: { enabled: false }, fontSize: 13, automaticLayout: true }}
          />
        </div>
      )}
    </Card>
  );
}
