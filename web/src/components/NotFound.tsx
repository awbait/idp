import { Link } from "react-router-dom";
import { IconError404 } from "@tabler/icons-react";

// NotFound: centered "page not found" state. Used both for unknown routes
// (catch-all) and for detail pages whose entity returned 404 (e.g. an order id
// that does not exist), so the user sees a friendly message instead of a raw
// "not_found" error string.
export function NotFound({
  title = "Страница не найдена",
  message = "Возможно, ссылка устарела или адрес введён неверно.",
  backTo = "/catalog",
  backLabel = "В каталог",
}: {
  title?: string;
  message?: string;
  backTo?: string;
  backLabel?: string;
}) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        <IconError404 size={38} stroke={1.5} />
      </span>
      <div>
        <h1 className="text-lg font-semibold text-slate-800">{title}</h1>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{message}</p>
      </div>
      <Link
        to={backTo}
        className="inline-flex items-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-on-accent outline-none transition-colors hover:bg-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        {backLabel}
      </Link>
    </div>
  );
}
