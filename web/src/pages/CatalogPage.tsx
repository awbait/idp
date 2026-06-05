import { Link } from "react-router-dom";
import { useTeam } from "../app/TeamContext";
import { useCatalog } from "../app/CatalogContext";
import { Card, ErrorBox, Spinner } from "../components/ui";

export function CatalogPage() {
  const { categories, charts, error, loading } = useCatalog();
  const { team } = useTeam();

  if (loading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;

  const categoryLabel = (id?: string) => categories.find((c) => c.id === id)?.label;

  // Charts available to the active team: no allowlist, or allowlist includes it.
  const visible = charts.filter(
    (c) => !team || !c.allowed_teams?.length || c.allowed_teams.includes(team),
  );

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">Чарты</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((c) => {
          const pub = c.publication;
          return (
            <Link key={`${c.project}/${c.name}`} to={`/catalog/${c.project}/${c.name}`}>
              <Card className="h-full transition hover:border-brand-400 hover:shadow">
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="font-medium text-gray-900">{c.name}</h2>
                  {/* Категория из публикации; чарт без публикации показывает
                      сырой Harbor-проект. */}
                  <span className="shrink-0 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                    {categoryLabel(pub?.category_id) ?? c.project}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-600">{c.description}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  <span className="rounded bg-gray-100 px-2 py-0.5">v{c.latest_version}</span>
                  <span>{c.versions.length} versions</span>
                  {pub && (
                    <span
                      title={`Владелец: ${pub.owner_team}${pub.created_by_name ? ` · Автор: ${pub.created_by_name}` : ""}`}
                      className="rounded bg-brand-50 px-2 py-0.5 text-brand-700"
                    >
                      {pub.owner_team}
                    </span>
                  )}
                  {/* Статус оформления в каталоге: чарт без публикации можно
                      оформить со страницы чарта («Опубликовать»). */}
                  {!pub ? (
                    <span
                      title="Чарт ещё не оформлен в каталоге — откройте его и нажмите «Опубликовать»"
                      className="rounded bg-gray-50 px-2 py-0.5 text-gray-400"
                    >
                      не опубликован
                    </span>
                  ) : !pub.published ? (
                    <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-700">
                      {pub.status === "PENDING" ? "на согласовании" : "view не согласована"}
                    </span>
                  ) : null}
                  {c.allowed_teams && c.allowed_teams.length > 0 && (
                    <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-700">
                      teams: {c.allowed_teams.join(", ")}
                    </span>
                  )}
                </div>
              </Card>
            </Link>
          );
        })}
        {visible.length === 0 && (
          <p className="text-sm text-gray-500">Нет доступных чартов{team ? ` для группы ${team}` : ""}.</p>
        )}
      </div>
    </div>
  );
}
