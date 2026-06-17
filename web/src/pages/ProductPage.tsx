import { Link, useParams } from "react-router-dom";
import { IconPlus, IconShoppingCart } from "@tabler/icons-react";
import { OrdersTable } from "../components/OrdersTable";
import { chartLabel, findCatalogChart, useCatalog } from "../app/CatalogContext";

// Product page (= a published chart): its orders list + "Order".
// Only charts with an approved order-view appear in the menu, but a direct URL
// works for any chart - then ordering is simply unavailable.
export function ProductPage() {
  const { project = "", name = "" } = useParams();
  const { charts, loading } = useCatalog();
  const chart = findCatalogChart(charts, project, name);
  const label = chartLabel(name);

  if (!loading && !chart) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        Чарт {project}/{name} не найден в каталоге.{" "}
        <Link to="/catalog" className="underline">
          К каталогу
        </Link>
        .
      </div>
    );
  }

  // Ordering is available when the order-view is approved. While the catalog
  // loads, show no button and no false "unavailable".
  const orderableKnown = !!chart;
  const orderable = !!chart?.publication?.published && !!chart?.publication?.has_order_view;
  const orderTo = orderable ? `/catalog/${project}/${name}/order` : undefined;
  const orderDisabledReason =
    orderableKnown && !orderable ? "Форма заказа не согласована для этого чарта" : undefined;

  return (
    <OrdersTable
      title={label}
      filter={(r) => r.chart_project === project && r.chart_name === name}
      orderTo={orderTo}
      orderDisabledReason={orderDisabledReason}
      emptyHint={
        orderTo ? (
          <div className="flex flex-col items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
              <IconShoppingCart size={24} stroke={1.6} />
            </span>
            <p>Заказов пока нет</p>
            <Link
              to={orderTo}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-surface px-3 py-1.5 font-medium text-slate-700 outline-none transition-colors hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <IconPlus size={16} stroke={1.7} className="text-slate-400" />
              Заказать
            </Link>
          </div>
        ) : orderDisabledReason ? (
          <>{orderDisabledReason}. Заказ недоступен, пока view не согласована.</>
        ) : undefined
      }
    />
  );
}
