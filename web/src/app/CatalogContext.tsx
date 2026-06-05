import { createContext, useContext, type ReactNode } from "react";
import { api } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import type { CatalogChart, Category } from "../api/types";

// Каталог (категории + чарты с оверлеем публикаций) загружается один раз и
// раздаётся через контекст: из него строятся левое меню, страница каталога и
// колонка «Категория» в списках заказов.
interface CatalogState {
  categories: Category[];
  charts: CatalogChart[];
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

const CatalogCtx = createContext<CatalogState>({
  categories: [],
  charts: [],
  loading: true,
  error: null,
  reload: () => {},
});

export function CatalogProvider({ children }: { children: ReactNode }) {
  const { data, loading, error, reload } = useAsync(() => api.getCatalog(), []);
  return (
    <CatalogCtx.Provider
      value={{
        categories: data?.categories ?? [],
        charts: data?.charts ?? [],
        loading,
        error,
        reload,
      }}
    >
      {children}
    </CatalogCtx.Provider>
  );
}

export function useCatalog() {
  return useContext(CatalogCtx);
}

// Чарт каталога по координатам (project/name).
export function findCatalogChart(
  charts: CatalogChart[],
  project: string,
  name: string,
): CatalogChart | undefined {
  return charts.find((c) => c.project === project && c.name === name);
}

// Чарт попадает в левое меню, когда его публикация согласована и view-документ
// содержит форму заказа (views.order).
export function inMenu(c: CatalogChart): boolean {
  return !!c.publication?.published && !!c.publication?.has_order_view;
}

// Дружелюбный лейбл чарта для меню/заголовков: "ingress-gateway" → "Ingress
// Gateway". Постоянное человеческое имя появится в публикации позже; пока —
// детерминированная косметика.
export function chartLabel(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
