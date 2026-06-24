import { IconCategory, IconTag, IconUser, IconUsersGroup } from "@tabler/icons-react";
import { Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { findCatalogChart, useCatalog } from "../app/CatalogContext";
import { canModify, useUser } from "../auth/UserContext";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { ProductIcon } from "../components/icons";
import { Markdown } from "../components/Markdown";
import { Button, Card, Chip, ErrorBox, Spinner } from "../components/ui";
import { useAsync } from "../hooks/useAsync";
import { isNewer } from "../lib/semver";

export function ChartDetailPage() {
  const { project = "", name = "" } = useParams();
  const { data: chart, error, loading } = useAsync(() => api.getChart(project, name), [project, name]);
  const { categories, charts: catalogCharts } = useCatalog();
  const { user } = useUser();
  const pub = findCatalogChart(catalogCharts, project, name)?.publication;
  // "Manage" for owners/admins; "Publish" (no publication yet) for any team
  // member (they pick the owner team at registration).
  const manageable = pub
    ? canModify(user, pub.owner_team)
    : user?.role === "admin" || (user?.teams?.length ?? 0) > 0;

  if (loading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  if (!chart) return null;

  // The profile shows the APPROVED version (like the catalog), not the live one
  // from Harbor: version, description, icon are the snapshot at approve time. The
  // live latest is only used to tell if an update is out in Harbor (nudge to "Manage").
  const liveVersion = chart.latest_version;
  const published = !!pub?.published;
  const version = (published && pub?.approved_view_version) || liveVersion;
  const description = (published && pub?.approved_description) || chart.description;
  // Ordering is open only for publications with an approved order-view; it leads
  // to the product page (its order list).
  const orderable = !!pub?.published && !!pub?.has_order_view;
  const categoryLabel = categories.find((c) => c.id === pub?.category_id)?.label;
  // A version newer than the approved one is in Harbor: time for the owner to
  // refresh the data (mark the "Manage" button with a dot).
  const viewOutdated =
    !!pub?.approved_view_version && isNewer(liveVersion, pub.approved_view_version);

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
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold">
            <ProductIcon project={chart.project} name={chart.name} size={24} />
            {chart.project}/{chart.name}
          </h1>
          <p className="text-sm text-gray-600">{description}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Chip className="bg-slate-100 text-slate-600">
              <IconTag size={13} stroke={1.8} className="text-slate-400" />
              <span className="text-slate-400">Версия:</span>v{version}
            </Chip>
            {categoryLabel && (
              <Chip className="bg-slate-100 text-slate-600">
                <IconCategory size={13} stroke={1.8} className="text-slate-400" />
                <span className="text-slate-400">Категория:</span>
                {categoryLabel}
              </Chip>
            )}
            {pub && (
              <Chip className="bg-brand-50 text-brand-700">
                <IconUsersGroup size={13} stroke={1.8} className="text-brand-400" />
                <span className="text-brand-400">Владелец:</span>
                {pub.owner_team}
              </Chip>
            )}
            {pub?.created_by_name && (
              <Chip className="bg-slate-100 text-slate-600">
                <IconUser size={13} stroke={1.8} className="text-slate-400" />
                <span className="text-slate-400">Автор:</span>
                {pub.created_by_name}
              </Chip>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {manageable && (
            <Link to={`/catalog/${project}/${name}/manage`} className="relative">
              <Button>{pub ? "Управление" : "Опубликовать"}</Button>
              {pub && viewOutdated && (
                <span
                  title="В Harbor есть новая версия чарта - актуализируйте данные"
                  className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-surface"
                />
              )}
            </Link>
          )}
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
