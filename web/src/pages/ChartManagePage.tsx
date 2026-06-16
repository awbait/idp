import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Editor, { DiffEditor } from "@monaco-editor/react";
import yaml from "js-yaml";
import {
  Button as AriaButton,
  Dialog,
  DialogTrigger,
  Heading,
  ListBox,
  ListBoxItem,
  Modal,
  ModalOverlay,
  Popover,
  Select as AriaSelect,
  SelectValue,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Tooltip,
  TooltipTrigger,
} from "react-aria-components";
import {
  IconAlertCircle,
  IconArrowNarrowRight,
  IconCategory,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconHelpCircle,
  IconInfoCircle,
  IconPencil,
  IconTag,
  IconUser,
  IconUsersGroup,
  IconX,
} from "@tabler/icons-react";
import { api, HttpError } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { useUser, canModify } from "../auth/UserContext";
import { chartLabel, useCatalog } from "../app/CatalogContext";
import { useTheme } from "../app/ThemeContext";
import { useToast } from "../app/ToastContext";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { Button, Card, Chip, ErrorBox, Select, Spinner, TextField } from "../components/ui";
import { StatusBadge } from "../components/StatusBadge";
import { ProductIcon } from "../components/icons";
import { pruneEmpty, type View } from "../form/SchemaForm";
import { OrderMetaCard, OrderValuesCard } from "../components/OrderFormParts";
import { Meta, ProductView } from "./requestDetailParts";
import type { PersistValues } from "../components/products/GenericProductTabs";
import type {
  ChartPublication,
  OrderRequest,
  PublicationStatus,
  ViewDocument,
  ViewIssue,
} from "../api/types";

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

const STATUS_LABELS: Record<PublicationStatus, { label: string; cls: string; Icon: typeof IconClock }> = {
  DRAFT: { label: "Черновик", cls: "bg-gray-100 text-gray-600", Icon: IconPencil },
  PENDING: { label: "На согласовании", cls: "bg-amber-50 text-amber-700", Icon: IconClock },
  APPROVED: { label: "Согласовано", cls: "bg-emerald-50 text-emerald-700", Icon: IconCheck },
  REJECTED: { label: "Отклонено", cls: "bg-red-50 text-red-700", Icon: IconAlertCircle },
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

  // Полноэкранный спиннер/ошибка — только на первичной загрузке (data ещё нет).
  // На фоновом перезапросе (reload после смены категории/владельца) useAsync
  // держит прежний pub, поэтому ManagePublication остаётся смонтированным и не
  // теряет незасохранённый черновик view.schema.json в редакторе.
  if (pubLoading && !pub) return <Spinner />;
  if (pubError && !pub) return <ErrorBox error={pubError} />;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
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
  const { theme } = useTheme();
  // Monaco живёт вне Tailwind-токенов: подбираем его тему под тему портала.
  const monacoTheme = theme === "light" ? "light" : "vs-dark";
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
  // Модалка «вышла новая версия» показывается один раз на каждую новую версию
  // из Harbor: в localStorage запоминаем (per-user, per-chart) версию, на которой
  // пользователь закрыл модалку; при следующей версии покажем снова.
  const seenKey = user ? `chart-version-nudge:${user.sub}:${project}/${name}` : null;
  const [seenVersion, setSeenVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!seenKey) return;
    try {
      setSeenVersion(localStorage.getItem(seenKey));
    } catch {
      /* localStorage недоступен - покажем модалку как обычно */
    }
  }, [seenKey]);
  const { success, error } = useToast();
  // Отклонённый черновик: при входе на страницу один раз показываем причину тостом.
  const firedReject = useRef(false);
  useEffect(() => {
    if (firedReject.current) return;
    if (pub.status === "REJECTED" && pub.review_comment) {
      firedReject.current = true;
      error(`Причина: ${pub.review_comment}`, { title: "Отклонено" });
    }
  }, [error, pub.status, pub.review_comment]);

  // Перетаскиваемый разделитель между панелью схем и предпросмотром: доля левой
  // панели в % (применяется только на lg, где панели бок о бок). Тянем за
  // разделитель — меняется ширина обеих.
  const splitRef = useRef<HTMLDivElement>(null);
  const [splitPct, setSplitPct] = useState(50);
  const splitDragging = useRef(false);
  function onSplitDown(e: React.PointerEvent) {
    splitDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  }
  useEffect(() => {
    function onMove(e: PointerEvent) {
      const el = splitRef.current;
      if (!splitDragging.current || !el) return;
      const r = el.getBoundingClientRect();
      setSplitPct(Math.min(75, Math.max(25, ((e.clientX - r.left) / r.width) * 100)));
    }
    function onUp() {
      if (!splitDragging.current) return;
      splitDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

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

  async function onSave(notify = false): Promise<boolean> {
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
      if (notify) success("Черновик сохранён");
      return true;
    } catch (e) {
      setErr(e instanceof HttpError ? e.message : (e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }

  // Категория/владелец правятся в чипах шапки, но это лишь черновик: live-значения
  // (по ним работают каталог и права) меняются только после согласования.
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
      success("Изменения отправлены на согласование");
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
  const catLabel = (id: string) => categories.find((c) => c.id === id)?.label ?? id;
  const categoryLabel = catLabel(pub.category_id);
  const ownerOptions = [
    ...new Set([...(user?.teams ?? []), pub.owner_team, pub.draft_owner_team].filter(Boolean) as string[]),
  ];
  // Несогласованная смена метаданных: предложения, ждущие approve (показываются
  // админу в карточке согласования).
  const proposals: { label: string; from: string; to: string }[] = [];
  if (pub.draft_category_id)
    proposals.push({ label: "Категория", from: categoryLabel, to: catLabel(pub.draft_category_id) });
  if (pub.draft_owner_team)
    proposals.push({ label: "Владелец", from: pub.owner_team, to: pub.draft_owner_team });

  // В Harbor вышла версия новее той, под которую согласован активный view, —
  // автору пора обновить view под новую схему.
  const viewOutdated =
    !!pub.approved_view_json &&
    !!pub.approved_view_version &&
    !!version &&
    version !== pub.approved_view_version;
  // Модалку показываем, только если эту версию пользователь ещё не закрывал.
  const showOutdated = viewOutdated && version !== seenVersion;
  function dismissOutdated() {
    setSeenVersion(version);
    if (seenKey) {
      try {
        localStorage.setItem(seenKey, version);
      } catch {
        /* нет localStorage - переживём, просто не запомним показ */
      }
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Управление: {chartLabel(name)}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {/* При статусе «Согласовано» показываем только «Опубликовано» (статус-чип
                его бы дублировал). В остальных статусах показываем статус черновика. */}
            {pub.status !== "APPROVED" &&
              (pub.status === "REJECTED" && pub.review_comment ? (
                // Чип отклонения кликабелен: причину показываем в модалке.
                <DialogTrigger>
                  <AriaButton
                    className={`inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs font-medium outline-none transition-[filter] hover:brightness-95 focus-visible:ring-2 focus-visible:ring-brand-500 ${st.cls}`}
                  >
                    <st.Icon size={13} stroke={1.8} />
                    {st.label}
                  </AriaButton>
                  <ModalOverlay
                    isDismissable
                    className="fixed inset-0 z-10 flex items-start justify-center bg-black/20 p-4 pt-24 entering:animate-in entering:fade-in"
                  >
                    <Modal className="w-full max-w-lg rounded-lg border border-slate-200 bg-surface shadow-xl">
                      <Dialog className="outline-none">
                        {({ close }) => (
                          <div className="flex flex-col items-center gap-3 p-5 text-center">
                            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-500">
                              <IconAlertCircle size={26} stroke={1.8} />
                            </span>
                            <Heading slot="title" className="text-base font-semibold text-slate-800">
                              Публикация отклонена
                            </Heading>
                            <p className="text-sm text-slate-600">
                              Администратор отклонил черновик. Причина:
                            </p>
                            <p className="w-full whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-left text-sm text-slate-700">
                              {pub.review_comment}
                            </p>
                            <Button onPress={close}>Понятно</Button>
                          </div>
                        )}
                      </Dialog>
                    </Modal>
                  </ModalOverlay>
                </DialogTrigger>
              ) : (
                <Chip className={st.cls}>
                  <st.Icon size={13} stroke={1.8} />
                  {st.label}
                </Chip>
              ))}
            {/* Действующая согласованная форма заказа. При «Согласовано» это
                единственный «зелёный» чип; при черновике/ревью/отклонении показывает,
                что старая форма заказа всё ещё работает. */}
            {pub.approved_view_json && (
              <Chip className="bg-emerald-50 text-emerald-700">
                <IconCheck size={12} stroke={2.5} />
                Опубликовано
              </Chip>
            )}
            <Chip className="bg-slate-100 text-slate-600">
              <IconTag size={13} stroke={1.8} className="text-slate-400" />
              <span className="text-slate-400">Версия:</span>
              {/* В управлении (и только тут) показываем, что в Harbor вышла новая
                  версия: согласованная -> новая, иначе просто текущая. */}
              {viewOutdated ? (
                <span className="inline-flex items-center gap-1">
                  v{pub.approved_view_version}
                  <IconArrowNarrowRight size={14} stroke={1.8} className="text-amber-600" />
                  <span className="text-amber-600">v{version}</span>
                </span>
              ) : (
                version && <span>v{version}</span>
              )}
            </Chip>
            {editable ? (
              <ChipSelect
                label="Категория"
                icon={<IconCategory size={13} stroke={1.8} className="text-slate-400" />}
                value={pub.draft_category_id || pub.category_id}
                pending={!!pub.draft_category_id}
                options={categories.map((c) => ({ id: c.id, label: c.label }))}
                onChange={(id) => onMetaChange({ category_id: id })}
                info="Категория изменится только после согласования"
              />
            ) : pub.draft_category_id ? (
              <ProposalChip label="Категория" from={categoryLabel} to={catLabel(pub.draft_category_id)} />
            ) : (
              <Chip className="bg-slate-100 text-slate-600">
                <IconCategory size={13} stroke={1.8} className="text-slate-400" />
                <span className="text-slate-400">Категория:</span>
                {categoryLabel}
              </Chip>
            )}
            {editable && ownerOptions.length > 1 ? (
              <ChipSelect
                label="Владелец"
                icon={<IconUsersGroup size={13} stroke={1.8} className="text-slate-400" />}
                value={pub.draft_owner_team || pub.owner_team}
                pending={!!pub.draft_owner_team}
                options={ownerOptions.map((t) => ({ id: t, label: t }))}
                onChange={(t) => onMetaChange({ owner_team: t })}
                info="Владелец изменится только после согласования"
              />
            ) : pub.draft_owner_team ? (
              <ProposalChip label="Владелец" from={pub.owner_team} to={pub.draft_owner_team} />
            ) : (
              <Chip className="bg-brand-50 text-brand-700">
                <IconUsersGroup size={13} stroke={1.8} className="text-brand-400" />
                <span className="text-brand-400">Владелец:</span>
                {pub.owner_team}
              </Chip>
            )}
            {pub.created_by_name && (
              <Chip className="bg-slate-100 text-slate-600">
                <IconUser size={13} stroke={1.8} className="text-slate-400" />
                <span className="text-slate-400">Автор:</span>
                {pub.created_by_name}
              </Chip>
            )}
          </div>
        </div>
        {editable && (
          <div className="flex shrink-0 gap-2">
            <Button isDisabled={busy !== null} onPress={() => onSave(true)}>
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

      {/* О новой версии чарта сообщаем модалкой при входе (один раз, до закрытия),
          а не постоянным баннером. */}
      <ModalOverlay
        isOpen={showOutdated}
        onOpenChange={(open) => !open && dismissOutdated()}
        isDismissable
        className="fixed inset-0 z-10 flex items-start justify-center bg-black/20 p-4 pt-24 entering:animate-in entering:fade-in"
      >
        <Modal className="w-full max-w-lg rounded-lg border border-slate-200 bg-surface shadow-xl">
          <Dialog className="outline-none">
            {({ close }) => (
              <div className="flex flex-col items-center gap-3 p-5 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-500">
                  <IconAlertCircle size={26} stroke={1.8} />
                </span>
                <Heading slot="title" className="text-base font-semibold text-slate-800">
                  Доступна новая версия чарта
                </Heading>
                <p className="text-sm text-slate-600">
                  Сейчас заказы работают на согласованной версии{" "}
                  <span className="font-medium text-slate-800">{pub.approved_view_version}</span>. В
                  Harbor вышла <span className="font-medium text-slate-800">{version}</span>. Чтобы
                  открыть обновление заказов до неё, обновите view под новую схему (вкладка
                  «values.schema.json») и отправьте на согласование.
                </p>
                <Button onPress={close}>Понятно</Button>
              </div>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
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

      {/* Согласование (admin, pending): смена метаданных + diff view. */}
      {pending && isAdmin && (
        <Card className="flex flex-col gap-3 border-amber-200">
          <h2 className="text-sm font-semibold text-slate-800">Согласование</h2>
          {proposals.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-md border border-amber-200 bg-amber-50/60 p-3">
              <p className="text-xs font-medium text-amber-800">Смена метаданных</p>
              <div className="flex flex-wrap gap-1.5">
                {proposals.map((p) => (
                  <ProposalChip key={p.label} label={p.label} from={p.from} to={p.to} />
                ))}
              </div>
            </div>
          )}
          {pub.approved_view_json ? (
            <div className="overflow-hidden rounded-md border border-slate-200">
              <DiffEditor
                height="280px"
                language="json"
                theme={monacoTheme}
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

      {/* Конструктор: слева документ (+ схема чарта рядом, read-only), справа предпросмотр.
          Растягивается на всю свободную высоту страницы (без внешнего скролла): редактор
          и предпросмотр заполняют колонку, скролл — только внутренний. Между панелями —
          перетаскиваемый разделитель (на lg), доля левой панели = --split. */}
      <div
        ref={splitRef}
        className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row lg:gap-0"
        style={{ ["--split" as string]: `${splitPct}%` } as React.CSSProperties}
      >
        <Card className="flex min-h-0 flex-col gap-2 lg:min-w-0 lg:shrink-0 lg:basis-[var(--split)]">
          <Tabs className="flex min-h-0 flex-1 flex-col">
            <TabList aria-label="Документы" className="flex gap-1 border-b border-gray-200">
              <EditorTab id="view">view.schema.json</EditorTab>
              <EditorTab id="schema">values.schema.json</EditorTab>
            </TabList>
            <TabPanel id="view" className="flex min-h-0 flex-1 flex-col gap-2 pt-3 outline-none">
              <div className="min-h-[400px] flex-1 overflow-hidden rounded-md border border-slate-200 lg:min-h-0">
                <Editor
                  height="100%"
                  defaultLanguage="json"
                  theme={monacoTheme}
                  value={text}
                  onChange={(v) => setText(v ?? "")}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    automaticLayout: true,
                    wordWrap: "on",
                    readOnly: !editable,
                  }}
                />
              </div>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {syntaxErr ? (
                    <div className="flex items-start gap-1.5 rounded-md border border-red-100 bg-red-50/50 p-2 text-xs text-red-700">
                      <IconAlertCircle size={14} stroke={1.8} className="mt-px shrink-0 text-red-500" />
                      <span>Синтаксис JSON: {syntaxErr}</span>
                    </div>
                  ) : issues.length > 0 ? (
                    <ul className="flex flex-col gap-1.5 rounded-md border border-red-100 bg-red-50/50 p-2 text-xs">
                      {issues.map((i, idx) => (
                        <li key={idx} className="flex items-start gap-1.5 text-red-700">
                          <IconAlertCircle size={14} stroke={1.8} className="mt-px shrink-0 text-red-500" />
                          <span>
                            {i.path && (
                              <code className="mr-1 rounded bg-surface px-1 py-px font-mono text-[11px] text-red-600 ring-1 ring-red-200">
                                {i.path}
                              </code>
                            )}
                            {i.message}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="flex items-center gap-1.5 rounded-md border border-emerald-100 bg-emerald-50/50 p-2 text-xs text-emerald-700">
                      <IconCheck size={14} stroke={2} className="shrink-0 text-emerald-500" />
                      Документ валиден
                    </div>
                  )}
                </div>
                <FormatHelp />
              </div>
            </TabPanel>
            {/* Схема чарта, источник полей для include/exclude/overrides; только чтение. */}
            <TabPanel id="schema" className="flex min-h-0 flex-1 flex-col gap-2 pt-3 outline-none">
              {schema ? (
                <>
                  <div className="min-h-[400px] flex-1 overflow-hidden rounded-md border border-slate-200 lg:min-h-0">
                    <Editor
                      height="100%"
                      defaultLanguage="json"
                      theme={monacoTheme}
                      value={JSON.stringify(schema, null, 2)}
                      options={{
                        minimap: { enabled: false },
                        fontSize: 13,
                        automaticLayout: true,
                        wordWrap: "on",
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

        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={onSplitDown}
          className="group hidden shrink-0 cursor-col-resize touch-none items-stretch justify-center px-1.5 lg:flex"
        >
          <div className="w-1 rounded-full bg-slate-200 transition-colors group-hover:bg-brand-400" />
        </div>

        <Card className="flex min-h-0 flex-col gap-2 lg:min-w-0 lg:flex-1">
          {!schema ? (
            <p className="text-sm text-gray-500">
              Схема values.schema.json недоступна, предпросмотр невозможен.
            </p>
          ) : viewNames.length === 0 ? (
            <p className="text-sm text-gray-500">Добавьте view в документ, чтобы увидеть форму.</p>
          ) : (
            <PreviewPane
              schema={schema as Record<string, any>}
              doc={parsed!}
              label={chartLabel(name)}
              project={project}
              name={name}
              version={version}
            />
          )}
        </Card>
      </div>
    </div>
  );
}

// ProposalChip, янтарный чип «было → стало (на согласовании)»: показывает
// несогласованную смену категории/владельца там, где правка недоступна.
function ProposalChip({ label, from, to }: { label: string; from: string; to: string }) {
  return (
    <Chip className="bg-amber-50 text-amber-700">
      <IconClock size={12} stroke={2} className="text-amber-500" aria-hidden />
      <span className="font-normal text-amber-500">{label}:</span>
      <span className="text-amber-600/70 line-through">{from}</span>
      <IconArrowNarrowRight size={13} stroke={2} className="text-amber-400" aria-hidden />
      {to}
    </Chip>
  );
}

// ChipSelect, селект в форме чипа: компактная правка категории/владельца прямо
// в шапке, без отдельной карточки метаданных. pending подсвечивает чип янтарём:
// выбранное значение — предложение, оно станет активным только после согласования.
function ChipSelect({
  label,
  icon,
  value,
  options,
  onChange,
  pending = false,
  info,
}: {
  label: string;
  icon?: React.ReactNode;
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
  pending?: boolean;
  info?: string;
}) {
  const tone = pending
    ? "bg-amber-50 text-amber-700 hover:bg-amber-100 data-[pressed]:bg-amber-100"
    : "bg-slate-100 text-slate-600 hover:bg-slate-200 data-[pressed]:bg-slate-200";
  return (
    <AriaSelect
      selectedKey={value}
      onSelectionChange={(k) => k !== value && onChange(String(k))}
      aria-label={label}
      className="inline-flex"
    >
      <AriaButton
        className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 ${tone}`}
      >
        {!pending && icon}
        {pending && (
          <span className="group/clock relative inline-flex">
            <IconClock size={12} stroke={2} className="text-amber-500" aria-hidden />
            {info && (
              <span
                role="tooltip"
                className="pointer-events-none invisible absolute bottom-full left-1/2 z-20 mb-1.5 w-max max-w-xs -translate-x-1/2 rounded-md border border-slate-200 bg-surface px-2.5 py-1.5 text-xs font-normal text-slate-700 opacity-0 shadow-lg transition-opacity duration-150 group-hover/clock:visible group-hover/clock:opacity-100"
              >
                {info}
              </span>
            )}
          </span>
        )}
        <span className={`font-normal ${pending ? "text-amber-500" : "text-slate-400"}`}>{label}:</span>
        <SelectValue />
        <IconChevronDown size={12} stroke={2} className={pending ? "text-amber-500" : "text-slate-400"} aria-hidden />
      </AriaButton>
      <Popover className="min-w-[var(--trigger-width)] rounded-md border border-slate-200 bg-surface shadow-lg entering:animate-in entering:fade-in">
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

function EditorTab({
  id,
  info,
  children,
}: {
  id: string;
  info?: string;
  children: React.ReactNode;
}) {
  return (
    <Tab
      id={id}
      className="-mb-px cursor-pointer border-b-2 border-transparent px-3 py-2 text-sm font-medium text-gray-500 outline-none transition-colors hover:text-gray-700 selected:border-brand-600 selected:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <span className="inline-flex items-center gap-1.5">
        {children}
        {info && <InfoHint text={info} />}
      </span>
    </Tab>
  );
}

// Иконка-подсказка: маленькая «i», показывает короткий текст в тултипе по
// наведению/фокусу. excludeFromTabOrder, чтобы не мешать навигации стрелками
// (например, по табам, рядом с которыми она стоит).
function InfoHint({ text }: { text: string }) {
  return (
    <TooltipTrigger delay={150} closeDelay={0}>
      <AriaButton
        excludeFromTabOrder
        aria-label={text}
        className="inline-flex items-center text-slate-400 outline-none transition-colors hover:text-brand-600 focus-visible:text-brand-600"
      >
        <IconInfoCircle size={15} stroke={1.8} />
      </AriaButton>
      <Tooltip
        offset={6}
        className="max-w-xs rounded-md border border-slate-200 bg-surface px-2.5 py-1.5 text-xs text-slate-700 shadow-lg entering:animate-in entering:fade-in entering:zoom-in-95"
      >
        {text}
      </Tooltip>
    </TooltipTrigger>
  );
}

// FormatHelp, справка по заполнению view.schema.json в модальном окне.
function FormatHelp() {
  return (
    <DialogTrigger>
      <AriaButton className="inline-flex h-[34px] w-fit shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-600 outline-none transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-brand-500">
        <IconHelpCircle size={14} className="text-slate-400" />
        Как заполнять
      </AriaButton>
      <ModalOverlay
        isDismissable
        className="fixed inset-0 z-10 flex items-start justify-center bg-black/20 p-4 pt-16 entering:animate-in entering:fade-in"
      >
        <Modal className="w-full max-w-2xl rounded-lg border border-slate-200 bg-surface shadow-xl">
          <Dialog className="outline-none">
            {({ close }) => (
              <div className="flex max-h-[80vh] flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <Heading slot="title" className="text-sm font-semibold text-slate-800">
                    Как заполнять view.schema.json
                  </Heading>
                  <AriaButton
                    onPress={close}
                    aria-label="Закрыть"
                    className="rounded p-1 text-slate-400 outline-none hover:bg-slate-100 hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <IconX size={16} />
                  </AriaButton>
                </div>
                <div className="overflow-y-auto text-xs leading-relaxed text-slate-600">
                  <p className="mb-1.5">
                    Документ из трёх разделов: <b>views</b> (формы), <b>tabs</b> (вкладки-таблицы), <b>actions</b>{" "}
                    (пункты меню «Действия»).
                  </p>
                  <ul className="flex list-disc flex-col gap-1.5 pl-4">
                    <li>
                      <b>views</b>: библиотека форм (проекций поверх values.schema.json). View <b>order</b>{" "}
                      обязательна: это форма нового заказа. Прочие views это формы элементов вкладок или формы
                      для «Действий». Сам по себе view не вкладка и не пункт меню.
                    </li>
                    <li>
                      <b>tabs</b>: вкладки продукта, каждая это таблица-список. Поля вкладки: <b>id</b>,{" "}
                      <b>title</b> (заголовок), <b>items</b> (JSON pointer на массив в values, например{" "}
                      <code className="rounded bg-slate-50 px-1 ring-1 ring-slate-200">"/gateways/0/listeners"</code>),{" "}
                      <b>form</b> (id формы элемента из views для добавления/изменения) и <b>ui:table</b>{" "}
                      (колонки:{" "}
                      <code className="rounded bg-slate-50 px-1 ring-1 ring-slate-200">{'[{"path":"name","label":"Имя"}]'}</code>).
                      Без <b>ui:table</b> вкладка покажет заглушку «не сконфигурировано».
                    </li>
                    <li>
                      <b>enums</b> (необязательно): динамические списки в форме элемента. Правило{" "}
                      <code className="rounded bg-slate-50 px-1 ring-1 ring-slate-200">{'{"at":"/parentRefs/0/sectionName","from":"/gateways/0/listeners","value":"name"}'}</code>{" "}
                      наполняет enum поля <b>at</b> значениями <b>value</b> из массива <b>from</b> в values заказа.
                    </li>
                    <li>
                      <b>lookup</b>-колонка (необязательно): вычисляемое значение через join по ссылке вместо{" "}
                      <b>path</b>:{" "}
                      <code className="rounded bg-slate-50 px-1 ring-1 ring-slate-200">{'{"label":"Hostnames","lookup":{"keys":"/parentRefs/*/sectionName","in":"/gateways/0/listeners","match":"name","get":"hostname"}}'}</code>.
                      Собирает <b>keys</b> из элемента (<b>*</b> перебирает массив), ищет в <b>in</b> строки где{" "}
                      <b>match</b> равен ключу, берёт <b>get</b>.
                    </li>
                    <li>
                      <b>actions</b>: кладёт форму-view пунктом в меню «Действия». Элемент:{" "}
                      <code className="rounded bg-slate-50 px-1 ring-1 ring-slate-200">{'{"view":"...","in":"info","label":"..."}'}</code>.{" "}
                      <b>in</b> = <code className="rounded bg-slate-50 px-1 ring-1 ring-slate-200">"info"</code>{" "}
                      (меню вкладки «Общая информация») или{" "}
                      <code className="rounded bg-slate-50 px-1 ring-1 ring-slate-200">{'"tab:<id>"'}</code>{" "}
                      (меню вкладки из <b>tabs</b>). <b>label</b> задаёт текст пункта.
                    </li>
                    <li>
                      <b>include</b> / <b>exclude</b>: какие поля показать или скрыть. <b>overrides</b>: настройка
                      поля (<b>title</b>, <b>ui:view</b> вложенная проекция). <b>ui:widget</b>: "single" массив как
                      один объект, "hidden" скрыть, "edit" раскрыть скрытое в схеме.
                    </li>
                    <li>
                      <b>identity</b>: JSON pointer на поле с именем сервиса, например{" "}
                      <code className="rounded bg-slate-50 px-1 ring-1 ring-slate-200">"/gateways/0/name"</code>.
                      Подписи полей форма берёт из <b>title</b> / <b>description</b> в values.schema.json.
                    </li>
                  </ul>
                  <pre className="mt-3 overflow-x-auto rounded-md bg-slate-50 p-3 ring-1 ring-slate-200">
                    {`{
  "views": {
    "order": {
      "identity": "/gateways/0/name",
      "include": ["naming", "gateways"],
      "overrides": {
        "gateways": { "ui:widget": "single", "ui:view": { "exclude": ["hpa"] } }
      }
    },
    "listener": {},
    "route": { "exclude": ["enabled", "hostnames"] },
    "resources": { "include": ["gateways"] }
  },
  "tabs": [
    {
      "id": "listeners",
      "title": "Слушатели",
      "items": "/gateways/0/listeners",
      "form": "listener",
      "ui:table": [
        { "path": "name", "label": "Имя" },
        { "path": "port", "label": "Порт" }
      ]
    },
    {
      "id": "routes",
      "title": "Маршруты",
      "items": "/xroutes",
      "form": "route",
      "enums": [
        { "at": "/parentRefs/0/sectionName", "from": "/gateways/0/listeners", "value": "name" }
      ],
      "ui:table": [
        { "path": "name", "label": "Имя" },
        { "label": "Hostnames", "lookup": { "keys": "/parentRefs/*/sectionName", "in": "/gateways/0/listeners", "match": "name", "get": "hostname" } }
      ]
    }
  ],
  "actions": [
    { "view": "resources", "in": "info", "label": "Редактировать ресурсы" }
  ]
}`}
                  </pre>
                </div>
              </div>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}

// readPointer достаёт строку из values по JSON pointer (identity предпросмотра).
function readPointer(v: unknown, ptr: string): string {
  let cur: any = v;
  for (const seg of ptr.split("/").slice(1)) {
    if (cur == null) return "";
    cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg];
  }
  return typeof cur === "string" ? cur : "";
}


// Предпросмотр строится теми же компонентами, что и реальные страницы (форма
// заказа из OrderFormParts, страница продукта из ProductView), поэтому он один в
// один совпадает с тем, что увидит пользователь. Значения локальные: правки в
// предпросмотре идут в стейт (persist), а не в API.
function PreviewPane({
  schema,
  doc,
  label,
  project,
  name,
  version,
}: {
  schema: Record<string, any>;
  doc: ViewDocument;
  label: string;
  project: string;
  name: string;
  version: string;
}) {
  const { user } = useUser();
  const orderView = doc.views?.order as (View & { identity?: string }) | undefined;
  const identity = orderView?.identity;

  // Состояние заказа: общее для формы и страницы продукта (заполнил форму,
  // переключил вкладку и видишь свой заказ).
  const [values, setValues] = useState<Values>({});
  const [displayName, setDisplayName] = useState(label);
  const [serviceName, setServiceName] = useState("");
  const [cluster, setCluster] = useState("in-cluster");
  const [namespace, setNamespace] = useState("");
  const [mode, setMode] = useState<"form" | "raw">("form");
  const [raw, setRaw] = useState("");

  // Та же логика переключения form/raw, что и на странице заказа.
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

  const team = user?.teams[0] ?? "team";
  const svcName = (identity ? readPointer(values, identity) : serviceName) || "demo-service";

  // Синтетический заказ: позволяет рендерить предпросмотр реальными компонентами
  // продукта без сохранённого заказа. id фиктивный, запись идёт через persist.
  const request: OrderRequest = {
    id: "preview",
    created_by: user?.sub ?? "",
    created_by_name: user?.name ?? "",
    team,
    chart_project: project,
    chart_name: name,
    chart_version: version,
    service_name: svcName,
    display_name: displayName,
    cluster,
    namespace: namespace || svcName,
    values_yaml: yaml.dump(pruneEmpty(values)),
    status: "HEALTHY",
    argocd_app_name: `${team}-${svcName}`,
    version: 1,
    created_at: "",
    updated_at: "",
    drifted: false,
    imported: false,
  };

  return (
    <Tabs className="flex min-h-0 flex-1 flex-col">
      <TabList aria-label="Предпросмотр" className="flex gap-1 border-b border-gray-200">
        <EditorTab id="order" info="Предпросмотр формы нового заказа">
          Форма заказа
        </EditorTab>
        <EditorTab id="product" info="Предпросмотр страницы заказанного продукта">
          Страница продукта
        </EditorTab>
      </TabList>
      <TabPanel
        id="order"
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1 pt-3 outline-none"
      >
        {orderView ? (
          <>
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
              team={team}
              version={version}
              latest
              identityName={identity ? readPointer(values, identity) : ""}
            />
            <OrderValuesCard
              schema={schema}
              view={orderView}
              values={values}
              onValues={setValues}
              mode={mode}
              onSwitchMode={switchMode}
              raw={raw}
              onRaw={setRaw}
            />
          </>
        ) : (
          <p className="text-sm text-gray-500">
            В документе нет view "order", форма заказа не строится.
          </p>
        )}
      </TabPanel>
      <TabPanel
        id="product"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-1 pt-3 outline-none"
      >
        <ProductPagePreview
          request={request}
          doc={doc}
          schema={schema}
          persist={(v) => setValues(v as Values)}
        />
      </TabPanel>
    </Tabs>
  );
}

// ProductPagePreview shows the order's product page exactly as RequestDetailPage
// renders it: the same header + meta card layout and the shared ProductView
// (tabs, tables, "Действия"). Edits write to local state via persist.
function ProductPagePreview({
  request,
  doc,
  schema,
  persist,
}: {
  request: OrderRequest;
  doc: ViewDocument;
  schema: Record<string, any>;
  persist: PersistValues;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
          <ProductIcon name={request.chart_name} size={22} />
        </span>
        <h1 className="truncate text-xl font-semibold">
          {request.display_name || request.service_name}
        </h1>
      </div>
      <Card className="grid grid-cols-3 gap-4">
        <Meta label="Создатель">
          <span className="text-sm text-gray-800">{request.created_by_name || "-"}</span>
        </Meta>
        <Meta label="Создан">
          <span className="text-sm text-gray-800">-</span>
        </Meta>
        <Meta label="Статус">
          <StatusBadge status={request.status} />
        </Meta>
      </Card>
      <ProductView
        request={request}
        doc={doc}
        modifiable
        reload={() => {}}
        schema={schema}
        persist={persist}
      />
    </div>
  );
}
