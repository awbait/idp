import { IconCheck, IconPlus, IconX } from "@tabler/icons-react";
import { useState } from "react";
import {
  Button as AriaButton,
  Dialog,
  DialogTrigger,
  Heading,
  Modal,
  ModalOverlay,
} from "react-aria-components";
import { useNavigate } from "react-router-dom";
import { api, HttpError } from "../api/client";
import type { ChartCheckResult } from "../api/types";
import { useCatalog } from "../app/CatalogContext";
import { useUser } from "../auth/UserContext";
import { Button, Select, TextField } from "./ui";

// "Add chart": a chart may live at an arbitrary path in Harbor (outside the
// configured projects). Enter project/name -> check it exists and the files are
// complete -> pick a category/owner -> publish (draft, then the view builder).
export function AddChartDialog() {
  const { user } = useUser();
  const { categories, reload: reloadCatalog } = useCatalog();
  const navigate = useNavigate();

  const [path, setPath] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ChartCheckResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [ownerTeam, setOwnerTeam] = useState<string | null>(user?.teams?.[0] ?? null);
  const [busy, setBusy] = useState(false);
  // Chart already published (409); instead of the form, offer to go to manage.
  const [conflict, setConflict] = useState(false);

  const teams = user?.teams ?? [];
  const isAdmin = user?.role === "admin";
  if (!isAdmin && teams.length === 0) return null; // auditor/support/security: publishing unavailable

  function reset() {
    setPath("");
    setResult(null);
    setErr(null);
    setChecking(false);
    setBusy(false);
    setConflict(false);
  }

  async function onCheck() {
    setChecking(true);
    setErr(null);
    setResult(null);
    try {
      setResult(await api.checkChart(path.trim()));
    } catch (e) {
      setErr(e instanceof HttpError ? e.message : (e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function onPublish(close: () => void) {
    const chart = result?.chart;
    if (!chart || !categoryId || !ownerTeam) {
      setErr("Выберите категорию и группу-владельца.");
      return;
    }
    setBusy(true);
    setErr(null);
    setConflict(false);
    try {
      await api.createPublication({
        chart: `${chart.project}/${chart.name}`,
        category_id: categoryId,
        owner_team: ownerTeam,
      });
      reloadCatalog();
      close();
      reset();
      navigate(`/catalog/${chart.project}/${chart.name}/manage`);
    } catch (e) {
      if (e instanceof HttpError && e.status === 409) setConflict(true);
      setErr(e instanceof HttpError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogTrigger onOpenChange={(open) => !open && reset()}>
      <AriaButton className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-on-accent outline-none hover:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500">
        <IconPlus size={16} stroke={2} />
        Добавить сервис
      </AriaButton>
      <ModalOverlay
        isDismissable
        className="fixed inset-0 z-10 flex items-start justify-center bg-black/20 p-4 pt-24 entering:animate-in entering:fade-in"
      >
        <Modal className="w-full max-w-lg rounded-lg border border-slate-200 bg-surface shadow-xl">
          <Dialog className="outline-none">
            {({ close }) => (
              <div className="flex flex-col gap-3 p-4">
                <div>
                  <Heading slot="title" className="text-sm font-semibold text-slate-800">
                    Добавить сервис из Harbor
                  </Heading>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Чарты из настроенных проектов появляются в каталоге автоматически. Чарт по
                    другому пути добавьте здесь: укажите project/name, проверим, что он на месте
                    и в комплекте есть нужные файлы.
                  </p>
                </div>

                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <TextField
                      label="Путь в Harbor"
                      value={path}
                      onChange={(v: string) => setPath(v)}
                      placeholder="project/name"
                    />
                  </div>
                  <Button isDisabled={checking || !path.includes("/")} onPress={onCheck}>
                    {checking ? "Проверяем…" : "Проверить"}
                  </Button>
                </div>

                {err && (
                  <div className="text-sm text-red-600">
                    <p>{err}</p>
                    {conflict && result?.chart && (
                      <button
                        type="button"
                        onClick={() => {
                          const c = result.chart!;
                          close();
                          reset();
                          navigate(`/catalog/${c.project}/${c.name}/manage`);
                        }}
                        className="mt-1 text-brand-600 underline hover:text-brand-700"
                      >
                        Открыть управление этим чартом
                      </button>
                    )}
                  </div>
                )}

                {result && (
                  <div className="flex flex-col gap-2 rounded-md border border-slate-200 p-3">
                    {result.chart ? (
                      <div className="text-sm">
                        <span className="font-medium text-slate-800">
                          {result.chart.project}/{result.chart.name}
                        </span>{" "}
                        <span className="text-xs text-slate-400">
                          v{result.chart.latest_version}
                        </span>
                        {result.chart.description && (
                          <p className="mt-0.5 text-xs text-slate-500">{result.chart.description}</p>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-red-600">{result.error}</p>
                    )}
                    {result.files && (
                      <ul className="flex flex-col gap-1 text-xs">
                        {result.files.map((f) => (
                          <li key={f.name} className="flex items-center gap-1.5">
                            {f.found ? (
                              <IconCheck size={14} className="text-emerald-600" />
                            ) : (
                              <IconX size={14} className={f.required ? "text-red-600" : "text-slate-400"} />
                            )}
                            <code>{f.name}</code>
                            {f.required && !f.found && <span className="text-red-600">обязателен</span>}
                            {!f.required && !f.found && <span className="text-slate-400">опционален</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                    {result.error && result.chart && (
                      <p className="text-xs text-red-600">{result.error}</p>
                    )}
                  </div>
                )}

                {result?.ok && (
                  <>
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
                    ) : (
                      <TextField
                        label="Группа-владелец"
                        value={ownerTeam ?? ""}
                        onChange={(v: string) => setOwnerTeam(v)}
                      />
                    )}
                  </>
                )}

                <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
                  <Button onPress={close}>Отмена</Button>
                  <Button
                    variant="primary"
                    isDisabled={!result?.ok || busy}
                    onPress={() => onPublish(close)}
                  >
                    Опубликовать
                  </Button>
                </div>
              </div>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}
