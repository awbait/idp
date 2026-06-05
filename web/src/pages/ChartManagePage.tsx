import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
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

  // Схема чарта (последняя версия) — для предпросмотра форм.
  const { data: chart } = useAsync(() => api.getChart(project, name), [project, name]);
  const version = chart?.latest_version ?? "";
  const { data: schema } = useAsync(
    () => (version ? api.getSchema(project, name, version) : Promise.resolve(null)),
    [project, name, version],
  );

  const pending = pub.status === "PENDING";
  const isAdmin = user?.role === "admin";
  const editable = canModify(user, pub.owner_team) && !pending;

  // Метаданные.
  const [categoryId, setCategoryId] = useState<string | null>(pub.category_id);
  const [ownerTeam, setOwnerTeam] = useState<string | null>(pub.owner_team);
  // Черновик view-документа в редакторе.
  const [text, setText] = useState(() =>
    pub.view_json ? JSON.stringify(pub.view_json, null, 2) : VIEW_TEMPLATE,
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "save" | "submit" | "approve" | "reject">(null);
  const [rejectComment, setRejectComment] = useState("");

  // Live-валидация: локальный JSON.parse — сразу, серверная (формат + сверка со
  // схемой чарта) — с дебаунсом.
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
        .catch(() => {}); // валидация — best effort, сеть мигнула — не страшно
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
      await api.updatePublication(pub.id, {
        category_id: categoryId ?? undefined,
        owner_team: ownerTeam ?? undefined,
        view: parsed,
      });
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Управление: {chartLabel(name)}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <span className={`rounded px-2 py-0.5 ${st.cls}`}>{st.label}</span>
            <span className="rounded bg-gray-100 px-2 py-0.5 text-gray-500">
              {project}/{name}
              {version ? ` · v${version}` : ""}
            </span>
            <span className="rounded bg-brand-50 px-2 py-0.5 text-brand-700">
              Владелец: {pub.owner_team}
              {pub.created_by_name ? ` · Автор: ${pub.created_by_name}` : ""}
            </span>
            {pub.approved_view_json && (
              <span className="rounded bg-emerald-50 px-2 py-0.5 text-emerald-700">
                view опубликована
              </span>
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
      {pending && !isAdmin && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Черновик на согласовании у администратора — правки заморожены до решения.
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
              Первая публикация view — действующей версии для сравнения нет.
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

      {/* Метаданные. */}
      {editable && (
        <Card className="flex max-w-lg flex-col gap-3">
          <Select
            label="Категория"
            selectedKey={categoryId}
            onSelectionChange={setCategoryId}
            options={categories.map((c) => ({ id: c.id, label: c.label }))}
          />
          {(user?.teams.length ?? 0) > 0 ? (
            <Select
              label="Группа-владелец"
              selectedKey={ownerTeam}
              onSelectionChange={setOwnerTeam}
              options={[...new Set([...(user?.teams ?? []), pub.owner_team])].map((t) => ({
                id: t,
                label: t,
              }))}
            />
          ) : (
            <TextField
              label="Группа-владелец"
              value={ownerTeam ?? ""}
              onChange={(v: string) => setOwnerTeam(v)}
            />
          )}
        </Card>
      )}

      {/* Конструктор: слева документ (+ схема чарта рядом, read-only), справа предпросмотр. */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="flex flex-col gap-2">
          <Tabs>
            <TabList aria-label="Документы" className="flex gap-1 border-b border-gray-200">
              <EditorTab id="view">view-документ</EditorTab>
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
                <ul className="flex flex-col gap-1 text-xs text-red-600">
                  {issues.map((i, idx) => (
                    <li key={idx}>
                      <code className="rounded bg-red-50 px-1">{i.path || "/"}</code> {i.message}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-emerald-600">Документ валиден.</p>
              )}
            </TabPanel>
            {/* Схема чарта — источник полей для include/exclude/overrides; только чтение. */}
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
                    values.schema.json из чарта{version ? ` (v${version})` : ""} — только чтение;
                    схема меняется только новой версией чарта.
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
              Схема values.schema.json недоступна — предпросмотр невозможен.
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

// Предпросмотр форм по каждой view документа — рендерим реальным SchemaForm с
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
