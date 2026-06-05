import { Link, useParams } from "react-router-dom";
import { OrdersTable } from "../components/OrdersTable";
import { chartLabel, findCatalogChart, useCatalog } from "../app/CatalogContext";

// Страница продукта (= опубликованного чарта): список его заказов + «Заказать».
// В меню попадают только чарты с согласованной order-view, но прямой переход по
// URL возможен для любого чарта — тогда заказ просто недоступен.
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

  // Заказ доступен при согласованной order-view. Пока каталог грузится — без
  // кнопки, без ложного «недоступно».
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
          <>Заказов {label} пока нет — нажмите «Заказать».</>
        ) : orderDisabledReason ? (
          <>{orderDisabledReason}. Заказ недоступен, пока view не согласована.</>
        ) : undefined
      }
    />
  );
}
