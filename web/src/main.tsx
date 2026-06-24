import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, Outlet, RouterProvider } from "react-router-dom";
import "./index.css";
import { CatalogProvider } from "./app/CatalogContext";
import { TeamProvider } from "./app/TeamContext";
import { ThemeProvider } from "./app/ThemeContext";
import { ToastProvider } from "./app/ToastContext";
import { UserProvider, useUser } from "./auth/UserContext";
import { Layout } from "./components/Layout";
import { NotFound } from "./components/NotFound";
import { AboutPage } from "./pages/AboutPage";
import {
  AdminApprovalDetailPage,
  AdminApprovalsPage,
  AdminCategoriesPage,
  AdminOverviewPage,
  AdminSection,
} from "./pages/AdminSection";
import { CatalogPage } from "./pages/CatalogPage";
import { ChartDetailPage } from "./pages/ChartDetailPage";
import { ChartManagePage } from "./pages/ChartManagePage";
import { DocsPage } from "./pages/DocsPage";
import { OrderPage } from "./pages/OrderPage";
import { ProductPage } from "./pages/ProductPage";
import { RequestDetailPage } from "./pages/RequestDetailPage";
import { RequestsPage } from "./pages/RequestsPage";
import {
  KyvernoPage,
  PolicyApprovalPage,
  SecurityOverviewPage,
  SecuritySection,
} from "./pages/SecuritySection";
import { StatusPage } from "./pages/StatusPage";

// Role-aware landing: security users open their section by default; everyone
// else lands on the catalog. Rendered inside Layout, which already gates on
// auth/loading, so the user is resolved by the time this runs.
function RoleHome() {
  const { user } = useUser();
  return <Navigate to={user?.role === "security" ? "/security" : "/catalog"} replace />;
}

// PlatformOnly guards the product (platform) routes. The security role lives in
// its own section and has no order/catalog access, so a direct URL bounces it
// back to /security. Other roles pass through.
function PlatformOnly() {
  const { user } = useUser();
  if (user?.role === "security") return <Navigate to="/security" replace />;
  return <Outlet />;
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <RoleHome /> },
      // About is informational and available to every role (outside PlatformOnly).
      { path: "about", element: <AboutPage /> },
      {
        path: "security",
        element: <SecuritySection />,
        children: [
          { index: true, element: <SecurityOverviewPage /> },
          { path: "policies", element: <PolicyApprovalPage /> },
          { path: "kyverno", element: <KyvernoPage /> },
        ],
      },
      // Platform-admin section: its own switcher section (like security), gated
      // to the admin role. Status lives here now; /status and /admin/publications
      // are kept as redirects so existing links/bookmarks don't break.
      {
        path: "admin",
        element: <AdminSection />,
        children: [
          { index: true, element: <AdminOverviewPage /> },
          { path: "approvals", element: <AdminApprovalsPage /> },
          { path: "approvals/:project/:name", element: <AdminApprovalDetailPage /> },
          { path: "categories", element: <AdminCategoriesPage /> },
          { path: "status", element: <StatusPage /> },
          { path: "publications", element: <Navigate to="/admin/approvals" replace /> },
        ],
      },
      { path: "status", element: <Navigate to="/admin/status" replace /> },
      // Platform (product) routes: blocked for the security role.
      {
        element: <PlatformOnly />,
        children: [
          { path: "catalog", element: <CatalogPage /> },
          { path: "catalog/:project/:name", element: <ChartDetailPage /> },
          { path: "catalog/:project/:name/order", element: <OrderPage /> },
          { path: "catalog/:project/:name/manage", element: <ChartManagePage /> },
          { path: "requests", element: <RequestsPage /> },
          { path: "requests/:id/edit", element: <OrderPage /> },
          { path: "requests/:id/upgrade", element: <OrderPage upgrade /> },
          { path: "products/:project/:name", element: <ProductPage /> },
          { path: "requests/:id", element: <RequestDetailPage /> },
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
  // Docs open standalone (no portal sidebar/topbar); they have a "Портал"
  // button to return to. Kept outside the Layout route on purpose.
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
