import { IconArrowUpCircle, IconCircleCheckFilled } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import type { CatalogChart } from "../api/types";
import { useCatalog } from "../app/CatalogContext";
import { useTeam } from "../app/TeamContext";
import { canModify, useUser } from "../auth/UserContext";
import { AddChartDialog } from "../components/AddChartDialog";
import { ProductIcon } from "../components/icons";
import { Card, ErrorBox, Spinner } from "../components/ui";
import { isNewer } from "../lib/semver";

type CatLabel = (id?: string) => string | undefined;

export function CatalogPage() {
  const { categories, charts, error, loading } = useCatalog();
  const { team } = useTeam();
  const { user } = useUser();

  if (loading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;

  const categoryLabel: CatLabel = (id) => categories.find((c) => c.id === id)?.label;

  // Charts available to the active team: no allowlist, or allowlist includes it.
  const visible = charts.filter(
    (c) => !team || !c.allowed_teams?.length || c.allowed_teams.includes(team),
  );

  // Approved: published with an order-view (passed moderation + has a view);
  // the rest: found by scan / in progress / under review.
  const isApproved = (c: CatalogChart) => !!c.publication?.published && !!c.publication?.has_order_view;
  const approved = visible.filter(isApproved);
  const others = visible.filter((c) => !isApproved(c));

  // Notify owners: a version newer than the approved one is out in Harbor for their charts.
  const outdated = visible.filter((c) => {
    const p = c.publication;
    return (
      !!p &&
      canModify(user, p.owner_team) &&
      !!p.approved_view_version &&
      !c.missing &&
      isNewer(c.latest_version, p.approved_view_version)
    );
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Чарты</h1>
        <AddChartDialog />
      </div>

      {outdated.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <IconArrowUpCircle size={18} stroke={1.8} className="mt-0.5 shrink-0 text-amber-500" />
          <div className="min-w-0">
            <p className="font-medium">В Harbor вышли новые версии ваших чартов</p>
            <p className="mt-0.5 text-amber-700">
              Обновите view под новую схему и согласуйте, чтобы актуализировать данные в каталоге и
              открыть обновление заказов:
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {outdated.map((c) => (
                <Link
                  key={`${c.project}/${c.name}`}
                  to={`/catalog/${c.project}/${c.name}/manage`}
                  className="inline-flex items-center gap-1 rounded-md bg-surface px-2 py-1 text-xs font-medium text-amber-800 ring-1 ring-amber-200 hover:bg-amber-100"
                >
                  {c.name}
                  <span className="text-amber-500">
                    {c.publication!.approved_view_version} → {c.latest_version}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      )}

      {approved.length > 0 && (
        <ChartSection title="Согласованные" charts={approved} categoryLabel={categoryLabel} />
      )}
      {others.length > 0 && (
        <ChartSection title="Остальные" charts={others} categoryLabel={categoryLabel} />
      )}
      {visible.length === 0 && (
        <p className="text-sm text-gray-500">Нет доступных чартов{team ? ` для группы ${team}` : ""}.</p>
      )}
    </div>
  );
}

function ChartSection({
  title,
  charts,
  categoryLabel,
}: {
  title: string;
  charts: CatalogChart[];
  categoryLabel: CatLabel;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
        {title}
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
          {charts.length}
        </span>
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {charts.map((c) => (
          <ChartCard key={`${c.project}/${c.name}`} chart={c} categoryLabel={categoryLabel} />
        ))}
      </div>
    </section>
  );
}

function ChartCard({ chart: c, categoryLabel }: { chart: CatalogChart; categoryLabel: CatLabel }) {
  const pub = c.publication;
  const approved = !!pub?.published && !!pub?.has_order_view;
  // Approved charts show a snapshot (version + description + icon at approve time),
  // not the live Harbor data; the rest show live data. For approved charts take the
  // icon strictly from the snapshot (even if empty), else a new version's icon leaks.
  const version = (approved && pub?.approved_view_version) || c.latest_version;
  const description = (approved && pub?.approved_description) || c.description;
  const category = categoryLabel(pub?.category_id);
  return (
    <Link to={`/catalog/${c.project}/${c.name}`}>
      <Card className="h-full transition hover:border-brand-400 hover:shadow">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="flex min-w-0 items-center gap-1.5 font-medium text-gray-900">
            <ProductIcon project={c.project} name={c.name} size={20} />
            <span className="truncate">{c.name}</span>
            {/* Published and approved: a plain green check. */}
            {approved && (
              <IconCircleCheckFilled
                size={16}
                className="shrink-0 text-emerald-500"
                title="Опубликован в каталоге"
              />
            )}
          </h2>
          {category && (
            <span className="shrink-0 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
              {category}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-gray-600">{description}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-500">
          {c.missing ? (
            <span
              title="Публикация ссылается на чарт, которого больше нет в Harbor"
              className="rounded bg-red-50 px-2 py-0.5 text-red-700"
            >
              нет в Harbor
            </span>
          ) : (
            <span className="rounded bg-gray-100 px-2 py-0.5">v{version}</span>
          )}
          {pub && (
            <span
              title={`Владелец: ${pub.owner_team}${pub.created_by_name ? ` · Автор: ${pub.created_by_name}` : ""}`}
              className="rounded bg-brand-50 px-2 py-0.5 text-brand-700"
            >
              {pub.owner_team}
            </span>
          )}
          {pub?.status === "PENDING" && (
            <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-700">на согласовании</span>
          )}
          {c.allowed_teams && c.allowed_teams.length > 0 && (
            <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-700">
              teams: {c.allowed_teams.join(", ")}
            </span>
          )}
        </div>
      </Card>
    </Link>
  );
}
