import { createContext, useContext, type ReactNode } from "react";
import { api } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import type { CatalogChart, Category } from "../api/types";

// The catalog (categories + charts with a publication overlay) loads once and
// is shared via context: it drives the left menu, the catalog page, and the
// "Category" column in order lists.
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

// Catalog chart by coordinates (project/name).
export function findCatalogChart(
  charts: CatalogChart[],
  project: string,
  name: string,
): CatalogChart | undefined {
  return charts.find((c) => c.project === project && c.name === name);
}

// A chart appears in the left menu when its publication is approved and the
// view document contains an order form (views.order).
export function inMenu(c: CatalogChart): boolean {
  return !!c.publication?.published && !!c.publication?.has_order_view;
}

// Friendly chart label for menu/headers: "ingress-gateway" -> "Ingress
// Gateway". A permanent human name will come from the publication later; for
// now - deterministic cosmetics.
export function chartLabel(name: string): string {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
