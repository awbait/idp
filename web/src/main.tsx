import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createBrowserRouter, Navigate } from "react-router-dom";
import "./index.css";
import { Layout } from "./components/Layout";
import { ThemeProvider } from "./app/ThemeContext";
import { ToastProvider } from "./app/ToastContext";
import { UserProvider } from "./auth/UserContext";
import { TeamProvider } from "./app/TeamContext";
import { CatalogProvider } from "./app/CatalogContext";
import { CatalogPage } from "./pages/CatalogPage";
import { ChartDetailPage } from "./pages/ChartDetailPage";
import { OrderPage } from "./pages/OrderPage";
import { RequestsPage } from "./pages/RequestsPage";
import { RequestDetailPage } from "./pages/RequestDetailPage";
import { ApplicationsPage } from "./pages/ApplicationsPage";
import { ProductPage } from "./pages/ProductPage";
import { ChartManagePage } from "./pages/ChartManagePage";
import { AdminPublicationsPage } from "./pages/AdminPublicationsPage";
import { StatusPage } from "./pages/StatusPage";
import { DocsPage } from "./pages/DocsPage";
import { NotFound } from "./components/NotFound";

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/catalog" replace /> },
      { path: "catalog", element: <CatalogPage /> },
      { path: "catalog/:project/:name", element: <ChartDetailPage /> },
      { path: "catalog/:project/:name/order", element: <OrderPage /> },
      { path: "catalog/:project/:name/manage", element: <ChartManagePage /> },
      { path: "admin/publications", element: <AdminPublicationsPage /> },
      { path: "requests", element: <RequestsPage /> },
      { path: "requests/:id/edit", element: <OrderPage /> },
      { path: "requests/:id/upgrade", element: <OrderPage upgrade /> },
      { path: "products/:project/:name", element: <ProductPage /> },
      { path: "requests/:id", element: <RequestDetailPage /> },
      { path: "applications", element: <ApplicationsPage /> },
      { path: "status", element: <StatusPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
  // Docs open standalone (no portal sidebar/topbar); they have a "Портал"
  // button to return. Kept outside the Layout route on purpose.
  { path: "/docs", element: <DocsPage /> },
  { path: "/docs/:slug", element: <DocsPage /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <UserProvider>
          <TeamProvider>
            <CatalogProvider>
              <RouterProvider router={router} />
            </CatalogProvider>
          </TeamProvider>
        </UserProvider>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
