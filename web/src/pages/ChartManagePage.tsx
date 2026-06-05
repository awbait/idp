import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Editor, { DiffEditor } from "@monaco-editor/react";
import {
  Button as AriaButton,
  ListBox,
  ListBoxItem,
  Popover,
  Select as AriaSelect,
  SelectValue,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from "react-aria-components";
import { IconAlertCircle, IconCheck, IconChevronDown } from "@tabler/icons-react";
import { api, HttpError } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { useUser, canModify } from "../auth/UserContext";
import { chartLabel, useCatalog } from "../app/CatalogContext";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { Button, Card, ErrorBox, Select, Spinner, TextField } from "../components/ui";
import { SchemaForm, type View } from "../form/SchemaForm";
import type { ChartPublication, PublicationStatus, ViewDocument, ViewIssue } from "../api/types";

type Values = Record<string, unknown>;

// Шаблон view-документа для нового черновика.
const VIEW_TEMPLATE = `{
  "views": {
    "order": {
      "include": [],
      "overrides": {}
    }
  }
}
`;

const STATUS_LABELS: Record<PublicationStatus, { label: string; cls: string }> = {
  DRAFT: { label: "Черновик", cls: "bg-gray-100 text-gray-600" },
  PENDING: { label: "На согласовании", cls: "bg-amber-50 text-amber-700" },
  APPROVED: { label: "Согласовано", cls: "bg-emerald-50 text-emerald-700" },
  REJECTED: { label: "Отклонено", cls: "bg-red-50 text-red-700" },
};

// Управление публикацией чарта: метаданные (категория, владелец) + конструктор
// view-документа (Monaco + live-валидация + предпросмотр форм) + согласование.
export function ChartManagePage() {
  const { project = "", name = "" } = useParams();
  const { user } = useUser();

  // Полная публикация (list -> match по project: фильтр API ключует по имени).
  const {
    data: pub,
    loading: pubLoading,
    error: pubError,
    reload: reloadPub,
  } = useAsync(
    () =>
      api
        .listPublications({ chart: name })
        .then((list) => list.find((p) => p.chart_project === project) ?? null),
    [project, name],
  );

  if (pubLoading) return <Spinner />;
  if (pubError) return <ErrorBox error={pubError} />;

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumbs
        items={[
          { label: "Чарты", to: "/catalog" },
          { label: `${project}/${name}`, to: `/catalog/${project}/${name}` },
          { label: "Управление" },
        ]}
      />
      {pub ? (
        <ManagePublication pub={pub} reload={reloadPub} />
      ) : (
        <RegisterCard project={project} name={name} onCreated={reloadPub} />
      )}
      {!pub && user?.role === "viewer" && (
        <p className="text-sm text-gray-500">Публиковать чарты могут участники команд.</p>
      )}
    </div>
  );
}

// Регистрация чарта в каталоге: категория + группа-владелец.
function RegisterCard({
  project,
  name,
  onCreated,
}: {
  project: string;
  name: string;
  onCreated: () => void;
}) {
  const { user } = useUser();
  const { categories, reload: reloadCatalog } = useCatalog();
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [ownerTeam, setOwnerTeam] = useState<string | null>(user?.teams[0] ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isAdmin = user?.role === "admin";
  const teams = user?.teams ?? [];

  async function onCreate() {
    if (!categoryId || !ownerTeam) {
      setErr("Выберите категорию и группу-владельца.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.createPublication({
        chart: `${project}/${name}`,
        category_id: categoryId,
        owner_team: ownerTeam,
      });
      reloadCatalog();
      onCreated();
    } catch (e) {
      setErr(e instanceof HttpError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex max-w-lg flex-col gap-3">
      <div>
        <h1 className="text-lg font-semibold">Публикация чарта {chartLabel(name)}</h1>
        <p className="mt-1 text-sm text-gray-600">
          Зарегистрируйте чарт в каталоге: выберите категорию и группу, которая будет управлять
          публикацией. Автором станете вы.
        </p>
      </div>
      <Select
        label="Категория"
        isRequired
        selectedKey={categoryId}
        onSelectionChange={setCategoryId}
        options={categories.map((c) => ({ id: c.id, label: c.label }))}
      />
      {teams.length > 0 ? (
        <Select
          label="Группа-владелец"
          isRequired
          selectedKey={ownerTeam}
          onSelectionChange={setOwnerTeam}
          options={teams.map((t) => ({ id: t, label: t }))}
        />
      ) : isAdmin ? (
        <TextField
          label="Группа-владелец"
          value={ownerTeam ?? ""}
          onChange={(v: string) => setOwnerTeam(v)}
        />
      ) : null}
      {err && <p className="text-sm text-red-600">{err}</p>}
      <div>
        <Button variant="primary" isDisabled={busy} onPress={onCreate}>
          Опубликовать
        </Button>
      </div>
    </Card>
  );
}

function ManagePublication({ pub, reload }: { pub: ChartPublication; reload: () => void }) {
  const { user } = useUser();
  const { categories, reload: reloadCatalog } = useCatalog();
  const project = pub.chart_project;
  const name = pub.chart_name;

  // Схема чарта (последняя версия), для предпросмотра форм.
  const { data: chart } = useAsync(() => api.getChart(project, name), [project, name]);
  const version = chart?.latest_version ?? "";
  const { data: schema } = useAsync(
    () => (version ? api.getSchema(project, name, version) : Promise.resolve(null)),
    [project, name, version],
  );

  const pending = pub.status === "PENDING";
  const isAdmin = user?.role === "admin";
  const isOwner = canModify(user, pub.owner_team);
  const editable = isOwner && !pending;

  // Черновик view-документа в редакторе.
  const [text, setText] = useState(() =>
    pub.view_json ? JSON.stringify(pub.view_json, null, 2) : VIEW_TEMPLATE,
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "save" | "submit" | "approve" | "reject" | "withdraw">(null);
  const [rejectComment, setRejectComment] = useState("");

  // Live-валидация: локальный JSON.parse, сразу, серверная (формат + сверка со
  // схемой чарта), с дебаунсом.
  const [issues, setIssues] = useState<ViewIssue[]>([]);
  const [syntaxErr, setSyntaxErr] = useState<string | null>(null);
  const parsed = useMemo<ViewDocument | null>(() => {
    try {
      const doc = JSON.parse(text);
      setSyntaxErr(null);
      return doc;
    } catch (e) {
      setSyntaxErr((e as Error).message);
      return null;
    }
  }, [text]);
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!parsed) return;
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      api
        .validatePublication(pub.id, parsed)
        .then((r) => setIssues(r.issues))
        .catch(() => {}); // валидация, best effort, сеть мигнула, не страшно
    }, 500);
    return () => clearTimeout(debounce.current);
  }, [parsed, pub.id]);

  async function onSave(): Promise<boolean> {
    if (!parsed) {
      setErr("Исправьте синтаксис JSON перед сохранением.");
      return false;
    }
    setBusy("save");
    setErr(null);
    try {
      await api.updatePublication(pub.id, { view: parsed });
      reload();
      reloadCatalog();
      return true;
    } catch (e) {
      setErr(e instanceof HttpError ? e.message : (e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  // Категория/владелец правятся прямо в чипах шапки и сохраняются сразу.
  async function onMetaChange(patch: { category_id?: string; owner_team?: string }) {
    setErr(null);
    try {
      await api.updatePublication(pub.id, patch);
      reload();
      reloadCatalog();
    } catch (e) {
      setErr(e instanceof HttpError ? e.message : (e as Error).message);
    }
  }

  async function onSubmit() {
    if (!(await onSave())) return;
    setBusy("submit");
    try {
      await api.submitPublication(pub.id);
      reload();
    } catch (e) {
      setErr(e instanceof HttpError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onWithdraw() {
    setBusy("withdraw");
    setErr(null);
    try {
      await api.withdrawPublication(pub.id);
      reload();
    } catch (e) {
      setErr(e instanceof HttpError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onApprove() {
    setBusy("approve");
    setErr(null);
    try {
      await api.approvePublication(pub.id);
      reload();
      reloadCatalog();
    } catch (e) {
      setErr(e instanceof HttpError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onReject() {
    setBusy("reject");
    setErr(null);
    try {
      await api.rejectPublication(pub.id, rejectComment.trim());
      reload();
    } catch (e) {
      setErr(e instanceof HttpError ? e.message : (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const st = STATUS_LABELS[pub.status];
  const viewNames = Object.keys(parsed?.views ?? {});
  const categoryLabel = categories.find((c) => c.id === pub.category_id)?.label ?? pub.category_id;
  const ownerOptions = [...new Set([...(user?.teams ?? []), pub.owner_team])];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Управление: {chartLabel(name)}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Chip className={st.cls}>{st.label}</Chip>
            <Chip className="bg-slate-100 text-slate-600">
              {project}/{name}
              {version && <span className="text-slate-400">v{version}</span>}
            </Chip>
            {editable ? (
              <ChipSelect
                label="Категория"
                value={pub.category_id}
                options={categories.map((c) => ({ id: c.id, label: c.label }))}
                onChange={(id) => onMetaChange({ category_id: id })}
              />
            ) : (
              <Chip className="bg-slate-100 text-slate-600">
                <span className="text-slate-400">Категория:</span>
                {categoryLabel}
              </Chip>
            )}
            {editable && ownerOptions.length > 1 ? (
              <ChipSelect
                label="Владелец"
                value={pub.owner_team}
                options={ownerOptions.map((t) => ({ id: t, label: t }))}
                onChange={(t) => onMetaChange({ owner_team: t })}
              />
            ) : (
              <Chip className="bg-brand-50 text-brand-700">
                <span className="text-brand-400">Владелец:</span>
                {pub.owner_team}
              </Chip>
            )}
            {pub.created_by_name && (
              <Chip className="bg-slate-100 text-slate-600">
                <span className="text-slate-400">Автор:</span>
                {pub.created_by_name}
              </Chip>
            )}
            {pub.approved_view_json && (
              <Chip className="bg-emerald-50 text-emerald-700">
                <IconCheck size={12} stroke={2.5} />
                view опубликована
              </Chip>
            )}
          </div>
        </div>
        {editable && (
          <div className="flex shrink-0 gap-2">
            <Button isDisabled={busy !== null} onPress={onSave}>
              Сохранить черновик
            </Button>
            <Button
              variant="primary"
              isDisabled={busy !== null || !!syntaxErr || issues.length > 0}
              onPress={onSubmit}
            >
              Отправить на согласование
            </Button>
          </div>
        )}
      </div>

      {pub.status === "REJECTED" && pub.review_comment && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <p className="font-medium">Отклонено{pub.reviewed_by ? ` (${pub.reviewed_by})` : ""}</p>
          <p className="mt-0.5">{pub.review_comment}</p>
        </div>
      )}
      {pending && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span>Черновик на согласовании у администратора, правки заморожены до решения.</span>
          {isOwner && (
            <Button isDisabled={busy !== null} onPress={onWithdraw}>
              Отозвать для изменения
            </Button>
          )}
        </div>
      )}
      {err && <p className="text-sm text-red-600">{err}</p>}

      {/* Согласование (admin, pending): diff черновика против активной версии. */}
      {pending && isAdmin && (
        <Card className="flex flex-col gap-3 border-amber-200">
          <h2 className="text-sm font-semibold text-slate-800">Согласование</h2>
          {pub.approved_view_json ? (
            <div className="overflow-hidden rounded-md border border-slate-200">
              <DiffEditor
                height="280px"
                language="json"
                original={JSON.stringify(pub.approved_view_json, null, 2)}
                modified={JSON.stringify(pub.view_json ?? {}, null, 2)}
                options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 12 }}
              />
            </div>
          ) : (
            <p className="text-sm text-gray-500">
              Первая публикация view: действующей версии для сравнения нет.
            </p>
          )}
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <TextField
                label="Комментарий (для отклонения)"
                value={rejectComment}
                onChange={(v: string) => setRejectComment(v)}
              />
            </div>
            <Button variant="primary" isDisabled={busy !== null} onPress={onApprove}>
              Согласовать
            </Button>
            <Button variant="danger" isDisabled={busy !== null} onPress={onReject}>
              Отклонить
            </Button>
          </div>
        </Card>
      )}

      {/* Конструктор: слева документ (+ схема чарта рядом, read-only), справа предпросмотр. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="flex flex-col gap-2">
          <Tabs>
            <TabList aria-label="Документы" className="flex gap-1 border-b border-gray-200">
              <EditorTab id="view">view.schema.json</EditorTab>
              <EditorTab id="schema">values.schema.json</EditorTab>
            </TabList>
            <TabPanel id="view" className="flex flex-col gap-2 pt-3 outline-none">
              <div className="overflow-hidden rounded-md border border-slate-200">
                <Editor
                  height="480px"
                  defaultLanguage="json"
                  value={text}
                  onChange={(v) => setText(v ?? "")}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    automaticLayout: true,
                    readOnly: !editable,
                  }}
                />
              </div>
              {syntaxErr ? (
                <p className="text-xs text-red-600">Синтаксис: {syntaxErr}</p>
              ) : issues.length > 0 ? (
                <ul className="flex flex-col gap-1.5 rounded-md border border-red-100 bg-red-50/50 p-2 text-xs">
                  {issues.map((i, idx) => (
                    <li key={idx} className="flex items-start gap-1.5 text-red-700">
                      <IconAlertCircle size={14} stroke={1.8} className="mt-px shrink-0 text-red-500" />
                      <span>
                        {i.path && (
                          <code className="mr-1 rounded bg-white px-1 py-px font-mono text-[11px] text-red-600 ring-1 ring-red-200">
                            {i.path}
                          </code>
                        )}
                        {i.message}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="flex items-center gap-1.5 text-xs text-emerald-600">
                  <IconCheck size={14} stroke={2} />
                  Документ валиден.
                </p>
              )}
            </TabPanel>
            {/* Схема чарта, источник полей для include/exclude/overrides; только чтение. */}
            <TabPanel id="schema" className="flex flex-col gap-2 pt-3 outline-none">
              {schema ? (
                <>
                  <div className="overflow-hidden rounded-md border border-slate-200">
                    <Editor
                      height="480px"
                      defaultLanguage="json"
                      value={JSON.stringify(schema, null, 2)}
                      options={{
                        minimap: { enabled: false },
                        fontSize: 13,
                        automaticLayout: true,
                        readOnly: true,
                        domReadOnly: true,
                      }}
                    />
                  </div>
                  <p className="text-xs text-slate-400">
                    values.schema.json из чарта{version ? ` (v${version})` : ""}, только чтение.
                    Схема меняется только новой версией чарта.
                  </p>
                </>
              ) : (
                <p className="text-sm text-gray-500">Схема values.schema.json недоступна.</p>
              )}
            </TabPanel>
          </Tabs>
        </Card>

        <Card className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-slate-800">Предпросмотр</h2>
          {!schema ? (
            <p className="text-sm text-gray-500">
              Схема values.schema.json недоступна, предпросмотр невозможен.
            </p>
          ) : viewNames.length === 0 ? (
            <p className="text-sm text-gray-500">Добавьте view в документ, чтобы увидеть форму.</p>
          ) : (
            <PreviewTabs schema={schema as Record<string, any>} views={parsed!.views!} />
          )}
        </Card>
      </div>
    </div>
  );
}

// Chip, единый стиль бейджей шапки.
function Chip({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${className}`}>
      {children}
    </span>
  );
}

// ChipSelect, селект в форме чипа: компактная правка категории/владельца прямо
// в шапке, без отдельной карточки метаданных.
function ChipSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
}) {
  return (
    <AriaSelect
      selectedKey={value}
      onSelectionChange={(k) => k !== value && onChange(String(k))}
      aria-label={label}
      className="inline-flex"
    >
      <AriaButton className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 outline-none transition-colors hover:bg-slate-200 focus-visible:ring-2 focus-visible:ring-brand-500 data-[pressed]:bg-slate-200">
        <span className="font-normal text-slate-400">{label}:</span>
        <SelectValue />
        <IconChevronDown size={12} stroke={2} className="text-slate-400" aria-hidden />
      </AriaButton>
      <Popover className="min-w-[var(--trigger-width)] rounded-md border border-slate-200 bg-white shadow-lg entering:animate-in entering:fade-in">
        <ListBox className="max-h-60 overflow-auto p-1 outline-none">
          {options.map((o) => (
            <ListBoxItem
              key={o.id}
              id={o.id}
              className="cursor-pointer rounded px-2 py-1 text-xs outline-none focus:bg-brand-50 selected:bg-brand-100"
            >
              {o.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}

function EditorTab({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <Tab
      id={id}
      className="-mb-px cursor-pointer border-b-2 border-transparent px-3 py-2 text-sm font-medium text-gray-500 outline-none transition-colors hover:text-gray-700 selected:border-brand-600 selected:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      {children}
    </Tab>
  );
}

// Предпросмотр форм по каждой view документа, рендерим реальным SchemaForm с
// реальной схемой чарта; значения локальные, никуда не отправляются.
function PreviewTabs({ schema, views }: { schema: Record<string, any>; views: Record<string, View> }) {
  const names = Object.keys(views);
  const [values, setValues] = useState<Record<string, Values>>({});
  return (
    <Tabs>
      <TabList aria-label="Предпросмотр view" className="flex gap-1 border-b border-gray-200">
        {names.map((n) => (
          <EditorTab key={n} id={n}>
            {n}
          </EditorTab>
        ))}
      </TabList>
      {names.map((n) => (
        <TabPanel key={n} id={n} className="pt-3 outline-none">
          <div className="max-h-[440px] overflow-y-auto pr-1">
            <SchemaForm
              schema={schema}
              view={views[n]}
              value={values[n] ?? {}}
              onChange={(v) => setValues((prev) => ({ ...prev, [n]: v }))}
            />
          </div>
        </TabPanel>
      ))}
    </Tabs>
  );
}
