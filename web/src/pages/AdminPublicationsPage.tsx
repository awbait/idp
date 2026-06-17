import { useState } from "react";
import { Link } from "react-router-dom";
import { api, HttpError } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { useUser } from "../auth/UserContext";
import { useCatalog, chartLabel } from "../app/CatalogContext";
import { Button, Card, ErrorBox, Spinner, TextField } from "../components/ui";
import type { Category, PublicationStatus } from "../api/types";

const STATUS_BADGE: Record<PublicationStatus, { label: string; cls: string }> = {
  DRAFT: { label: "Черновик", cls: "bg-gray-100 text-gray-600" },
  PENDING: { label: "На согласовании", cls: "bg-amber-50 text-amber-700" },
  APPROVED: { label: "Согласовано", cls: "bg-emerald-50 text-emerald-700" },
  REJECTED: { label: "Отклонено", cls: "bg-red-50 text-red-700" },
};

// Publications admin: review queue (the decision is made on the chart manage
// page, which has the diff and preview) + category CRUD.
export function AdminPublicationsPage() {
  const { user } = useUser();
  if (user?.role !== "admin") {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        Раздел доступен только администраторам.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Публикации</h1>
      <ReviewQueue />
      <CategoriesAdmin />
    </div>
  );
}

function ReviewQueue() {
  const { data: pubs, error, loading } = useAsync(() => api.listPublications(), []);

  if (loading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;

  const pending = (pubs ?? []).filter((p) => p.status === "PENDING");
  const rest = (pubs ?? []).filter((p) => p.status !== "PENDING");

  const row = (p: NonNullable<typeof pubs>[number]) => {
    const st = STATUS_BADGE[p.status];
    return (
      <li key={p.id}>
        <Link
          to={`/catalog/${p.chart_project}/${p.chart_name}/manage`}
          className="flex items-center justify-between gap-3 rounded-md px-3 py-2 hover:bg-slate-50"
        >
          <span className="flex items-center gap-3">
            <span className="font-medium text-slate-800">{chartLabel(p.chart_name)}</span>
            <span className="text-xs text-slate-400">
              {p.chart_project}/{p.chart_name}
            </span>
          </span>
          <span className="flex items-center gap-2 text-xs">
            <span className="rounded bg-brand-50 px-2 py-0.5 text-brand-700">{p.owner_team}</span>
            <span className={`rounded px-2 py-0.5 ${st.cls}`}>{st.label}</span>
          </span>
        </Link>
      </li>
    );
  };

  return (
    <Card>
      <h2 className="mb-2 text-sm font-semibold text-slate-800">Очередь на согласование</h2>
      {pending.length === 0 ? (
        <p className="text-sm text-gray-500">Нет публикаций, ожидающих решения.</p>
      ) : (
        <ul className="-mx-3 flex flex-col">{pending.map(row)}</ul>
      )}
      {rest.length > 0 && (
        <>
          <h2 className="mb-2 mt-4 text-sm font-semibold text-slate-800">Все публикации</h2>
          <ul className="-mx-3 flex flex-col">{rest.map(row)}</ul>
        </>
      )}
    </Card>
  );
}

function CategoriesAdmin() {
  const { categories, reload } = useCatalog();
  const [draft, setDraft] = useState<Category>({ id: "", label: "", sort: 0 });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setErr(e instanceof HttpError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-slate-800">Категории каталога</h2>
      <ul className="flex flex-col gap-2">
        {categories.map((c) => (
          <CategoryRow key={c.id} category={c} busy={busy} run={run} />
        ))}
        {categories.length === 0 && <p className="text-sm text-gray-500">Категорий нет.</p>}
      </ul>
      <div className="flex items-end gap-2 border-t border-slate-100 pt-3">
        <TextField label="ID (slug)" value={draft.id} onChange={(v: string) => setDraft({ ...draft, id: v })} />
        <TextField
          label="Название"
          value={draft.label}
          onChange={(v: string) => setDraft({ ...draft, label: v })}
        />
        <TextField
          label="Порядок"
          value={String(draft.sort)}
          onChange={(v: string) => setDraft({ ...draft, sort: Number(v) || 0 })}
        />
        <Button
          variant="primary"
          isDisabled={busy || !draft.id.trim() || !draft.label.trim()}
          onPress={() =>
            run(() => api.createCategory({ ...draft, id: draft.id.trim(), label: draft.label.trim() })).then(
              () => setDraft({ id: "", label: "", sort: 0 }),
            )
          }
        >
          Добавить
        </Button>
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
    </Card>
  );
}

function CategoryRow({
  category,
  busy,
  run,
}: {
  category: Category;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [label, setLabel] = useState(category.label);
  const [sort, setSort] = useState(String(category.sort));
  const dirty = label !== category.label || Number(sort) !== category.sort;
  return (
    <li className="flex items-end gap-2">
      <span className="w-32 shrink-0 pb-2 text-sm text-slate-500">{category.id}</span>
      <TextField label="Название" hideLabel value={label} onChange={(v: string) => setLabel(v)} />
      <TextField label="Порядок" hideLabel value={sort} onChange={(v: string) => setSort(v)} />
      <Button
        isDisabled={busy || !dirty || !label.trim()}
        onPress={() => run(() => api.updateCategory({ id: category.id, label: label.trim(), sort: Number(sort) || 0 }))}
      >
        Сохранить
      </Button>
      <Button
        variant="danger"
        isDisabled={busy}
        onPress={() => run(() => api.deleteCategory(category.id))}
      >
        Удалить
      </Button>
    </li>
  );
}
