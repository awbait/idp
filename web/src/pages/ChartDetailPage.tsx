import { Link, useParams } from "react-router-dom";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import { api } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { Button, Card, ErrorBox, Spinner } from "../components/ui";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { Markdown } from "../components/Markdown";
import { findCatalogChart, useCatalog } from "../app/CatalogContext";

export function ChartDetailPage() {
  const { project = "", name = "" } = useParams();
  const { data: chart, error, loading } = useAsync(() => api.getChart(project, name), [project, name]);
  const { categories, charts: catalogCharts } = useCatalog();
  const pub = findCatalogChart(catalogCharts, project, name)?.publication;

  if (loading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  if (!chart) return null;

  // No version picker — the catalog always uses the latest tag.
  const version = chart.latest_version;
  // Заказ открыт только для публикаций с согласованной order-view; ведёт на
  // страницу продукта (его список заказов).
  const orderable = !!pub?.published && !!pub?.has_order_view;
  const categoryLabel = categories.find((c) => c.id === pub?.category_id)?.label;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <Breadcrumbs
            items={[
              { label: "Чарты", to: "/catalog" },
              { label: `${chart.project}/${chart.name}` },
            ]}
          />
          <h1 className="mt-1 text-xl font-semibold">
            {chart.project}/{chart.name}
          </h1>
          <p className="text-sm text-gray-600">{chart.description}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <span className="rounded bg-gray-100 px-2 py-0.5">v{version}</span>
            {categoryLabel && <span className="rounded bg-gray-100 px-2 py-0.5">{categoryLabel}</span>}
            {pub && (
              <span className="rounded bg-brand-50 px-2 py-0.5 text-brand-700">
                Владелец: {pub.owner_team}
                {pub.created_by_name ? ` · Автор: ${pub.created_by_name}` : ""}
              </span>
            )}
          </div>
        </div>
        {orderable ? (
          <Link to={`/products/${project}/${name}`}>
            <Button variant="primary">Заказать</Button>
          </Link>
        ) : (
          <span title="Форма заказа не согласована для этого чарта">
            <Button variant="primary" isDisabled>
              Заказать
            </Button>
          </span>
        )}
      </div>

      <Tabs>
        <TabList aria-label="Документация чарта" className="flex gap-1 border-b border-gray-200">
          <DocTab id="readme">README</DocTab>
          <DocTab id="changelog">CHANGELOG</DocTab>
        </TabList>
        <TabPanel id="readme" className="pt-4 outline-none">
          <Readme project={project} name={name} version={version} />
        </TabPanel>
        <TabPanel id="changelog" className="pt-4 outline-none">
          <Changelog project={project} name={name} />
        </TabPanel>
      </Tabs>
    </div>
  );
}

function DocTab({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <Tab
      id={id}
      className="-mb-px cursor-pointer border-b-2 border-transparent px-3 py-2 text-sm font-medium text-gray-500 outline-none transition-colors hover:text-gray-700 selected:border-brand-600 selected:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      {children}
    </Tab>
  );
}

function Readme({ project, name, version }: { project: string; name: string; version: string }) {
  const { data, error, loading } = useAsync(
    () => api.getReadme(project, name, version),
    [project, name, version],
  );
  return (
    <Card>
      {loading ? (
        <Spinner />
      ) : error || !data?.trim() ? (
        <p className="text-sm text-gray-500">README недоступен.</p>
      ) : (
        <Markdown>{data}</Markdown>
      )}
    </Card>
  );
}

function Changelog({ project, name }: { project: string; name: string }) {
  const { data, error, loading } = useAsync(
    () => api.getAggregatedChangelog(project, name),
    [project, name],
  );
  if (loading) return <Spinner label="Загрузка истории изменений…" />;
  if (error || !data?.length) return <p className="text-sm text-gray-500">CHANGELOG недоступен.</p>;
  return (
    <Card>
      <div className="flex flex-col gap-4">
        {data.map((e) => (
          <div key={e.version}>
            <div className="flex items-baseline gap-2">
              <span className="font-medium">{e.version}</span>
              {e.date && <span className="text-xs text-gray-400">{e.date}</span>}
            </div>
            {Object.entries(e.sections).map(([sec, items]) => (
              <div key={sec} className="mt-1">
                <span className="text-xs font-semibold uppercase text-gray-500">{sec}</span>
                <ul className="ml-4 list-disc text-sm text-gray-700">
                  {items.map((it, i) => (
                    <li key={i}>
                      <Markdown inline>{it}</Markdown>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}
