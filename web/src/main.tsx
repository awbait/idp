import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createBrowserRouter, Navigate } from "react-router-dom";
import "./index.css";
import { Layout } from "./components/Layout";
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
import { StatusPage } from "./pages/StatusPage";

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/catalog" replace /> },
      { path: "catalog", element: <CatalogPage /> },
      { path: "catalog/:project/:name", element: <ChartDetailPage /> },
      { path: "catalog/:project/:name/order", element: <OrderPage /> },
      { path: "requests", element: <RequestsPage /> },
      { path: "requests/:id/edit", element: <OrderPage /> },
      { path: "products/:project/:name", element: <ProductPage /> },
      { path: "requests/:id", element: <RequestDetailPage /> },
      { path: "applications", element: <ApplicationsPage /> },
      { path: "status", element: <StatusPage /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <UserProvider>
      <TeamProvider>
        <CatalogProvider>
          <RouterProvider router={router} />
        </CatalogProvider>
      </TeamProvider>
    </UserProvider>
  </StrictMode>,
);
