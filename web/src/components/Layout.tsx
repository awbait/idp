import { useEffect, useMemo, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import {
  Button,
  Dialog,
  DialogTrigger,
  Disclosure,
  DisclosureGroup,
  DisclosurePanel,
  Heading,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  ModalOverlay,
  Popover,
} from "react-aria-components";
import {
  IconActivity,
  IconBell,
  IconBook,
  IconBox,
  IconCheck,
  IconChecklist,
  IconChevronDown,
  IconChevronRight,
  IconCloud,
  IconInfoCircle,
  IconLayoutDashboard,
  IconLayoutGrid,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLogout,
  IconPackages,
  IconPalette,
  IconScan,
  IconShieldCheck,
  IconShieldLock,
  IconUser,
  IconUsersGroup,
} from "@tabler/icons-react";
import { api } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { useUser } from "../auth/UserContext";
import { useTeam } from "../app/TeamContext";
import { THEMES, THEME_LABELS, useTheme, type Theme } from "../app/ThemeContext";
import { chartLabel, inMenu, useCatalog } from "../app/CatalogContext";
import type { CatalogChart } from "../api/types";
import { categoryIcon } from "./icons";
import { Spinner } from "./ui";

const navItems = [
  { to: "/requests", label: "Список заказов", Icon: IconBox },
  { to: "/catalog", label: "Чарты", Icon: IconPackages },
];

// Extra items for admins (publication approvals + categories).
const adminNavItems = [{ to: "/admin/publications", label: "Публикации", Icon: IconChecklist }];

// Top-level sidebar sections. The platform section is the default product
// experience; the security (InfoSec) section swaps the lower nav for its own
// pages. The switcher only appears when a role can see more than one section.
type SectionId = "platform" | "security";

const SECTIONS: { id: SectionId; label: string; home: string; Icon: typeof IconBox }[] = [
  { id: "platform", label: "Платформа", home: "/catalog", Icon: IconLayoutGrid },
  { id: "security", label: "ИБ", home: "/security", Icon: IconShieldLock },
];

// Lower-nav items of the security section. The overview matches its route
// exactly so deeper pages don't also light it up.
const securitySectionNav: { to: string; label: string; Icon: typeof IconBox; exact?: boolean }[] = [
  { to: "/security", label: "Обзор", Icon: IconLayoutDashboard, exact: true },
  { to: "/security/policies", label: "Согласование политик", Icon: IconShieldCheck },
  { to: "/security/kyverno", label: "Kyverno UI", Icon: IconScan },
];

// Human-readable role labels for the profile menu.
const ROLE_LABELS: Record<string, string> = {
  auditor: "Аудитор",
  member: "Участник",
  support: "Поддержка",
  security: "Информационная безопасность",
  admin: "Администратор платформы",
};

export function Layout() {
  const { user, loading, unauthenticated } = useUser();
  const [collapsed, setCollapsed] = useState(false);
  const { pathname } = useLocation();

  // On a request detail/edit route the URL doesn't say which product it is, so
  // fetch the order and map its chart - that chart's sidebar item then lights
  // up (e.g. viewing an Ingress Gateway order highlights it).
  const reqId = pathname.match(/^\/requests\/([^/]+)(?:\/edit)?$/)?.[1];
  const { data: reqForNav } = useAsync(
    () => (reqId ? api.getRequest(reqId) : Promise.resolve(null)),
    [reqId],
  );
  const navReq = reqForNav?.request;

  // Sidebar product taxonomy is dynamic: catalog categories (admin-managed) ->
  // published charts whose approved view declares an order form. Categories
  // without a single such chart are hidden.
  const { categories, charts } = useCatalog();
  const menu = useMemo(
    () =>
      categories
        .map((cat) => ({
          ...cat,
          charts: charts.filter((c) => inMenu(c) && c.publication!.category_id === cat.id),
        }))
        .filter((g) => g.charts.length > 0),
    [categories, charts],
  );

  // A chart's menu item is "active" on its product page (/products/:project/:name),
  // while ordering it (/catalog/:project/:name/order - ordering is a product
  // action), and on a request of that chart (/requests/:id). Browsing the chart
  // itself (/catalog/:project/:name, no /order) is NOT a product - it belongs to
  // the "Charts" section, so that top-level item lights up there instead.
  const chartActive = (c: CatalogChart) =>
    pathname === `/products/${c.project}/${c.name}` ||
    pathname === `/catalog/${c.project}/${c.name}/order` ||
    (!!navReq && navReq.chart_project === c.project && navReq.chart_name === c.name);
  const activeReqInMenu =
    !!navReq && menu.some((g) => g.charts.some((c) => c.project === navReq.chart_project && c.name === navReq.chart_name));
  const activeCategory = menu.find((g) => g.charts.some(chartActive))?.id;

  // Controlled category expansion: all categories open by default, user toggles
  // persist, and the active category auto-expands (menu resolves async, so
  // defaultExpandedKeys alone wouldn't reopen it).
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [expandedInit, setExpandedInit] = useState(false);
  useEffect(() => {
    if (!expandedInit && menu.length > 0) {
      setExpanded(new Set(menu.map((g) => g.id)));
      setExpandedInit(true);
    }
  }, [expandedInit, menu]);
  useEffect(() => {
    if (activeCategory) {
      setExpanded((prev) => (prev.has(activeCategory) ? prev : new Set(prev).add(activeCategory)));
    }
  }, [activeCategory]);

  // Top-level nav active state. "Charts"/"Orders list" must NOT light up when
  // the route belongs to a product (ordering a gateway under /catalog/…, or
  // viewing a gateway order under /requests/:id) - the product item owns it.
  const navActive = (to: string) => {
    if (to === "/catalog")
      return (pathname === "/catalog" || pathname.startsWith("/catalog/")) && !activeCategory;
    if (to === "/requests")
      return (pathname === "/requests" || pathname.startsWith("/requests/")) && !activeReqInMenu;
    return pathname === to || pathname.startsWith(`${to}/`);
  };

  // Publication builder (manage) - a wide two-pane editor: drop the content
  // width limit here so the editor + preview fill the whole screen.
  const fullBleed = /^\/catalog\/[^/]+\/[^/]+\/manage$/.test(pathname);

  if (loading) return <Spinner />;
  if (unauthenticated || !user) return <LoginScreen />;

  // Sections by role: security sees only its own section, admin sees both,
  // everyone else only the platform section. The active section follows the URL,
  // clamped to what the role may actually see.
  const availableSections = SECTIONS.filter((s) =>
    s.id === "security" ? user.role === "security" || user.role === "admin" : user.role !== "security",
  );
  const pathSection: SectionId = pathname.startsWith("/security") ? "security" : "platform";
  const activeSection: SectionId = availableSections.some((s) => s.id === pathSection)
    ? pathSection
    : (availableSections[0]?.id ?? "platform");

  return (
    <div className="flex h-screen bg-slate-50 text-slate-800">
      {/* LEFT NAV - full height; width animates (px->px) for a smooth collapse */}
      <aside
        className={`flex shrink-0 flex-col overflow-hidden border-r border-slate-200 bg-surface transition-[width] duration-300 ease-in-out ${
          collapsed ? "w-16" : "w-[260px]"
        }`}
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-slate-100 px-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-600 text-on-accent">
            <IconCloud size={20} stroke={1.8} />
          </span>
          {!collapsed && (
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-sm font-semibold text-slate-800">Console</span>
              <span className="truncate text-[11px] text-slate-400">Managed Services</span>
            </div>
          )}
        </div>

        {/* section switcher (only when a role can see more than one section) */}
        {availableSections.length > 1 &&
          (collapsed ? (
            <nav className="flex flex-col gap-1 px-2 pt-3">
              {availableSections.map((s) => {
                const Icon = s.Icon;
                return (
                  <Link
                    key={s.id}
                    to={s.home}
                    title={s.label}
                    aria-current={activeSection === s.id ? "page" : undefined}
                    className="flex justify-center rounded-md px-3 py-2 text-slate-500 hover:bg-slate-50 aria-[current=page]:bg-brand-50 aria-[current=page]:text-brand-700"
                  >
                    <Icon size={20} stroke={1.7} />
                  </Link>
                );
              })}
            </nav>
          ) : (
            <div className="px-3 pt-3">
              <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
                {availableSections.map((s) => {
                  const Icon = s.Icon;
                  return (
                    <Link
                      key={s.id}
                      to={s.home}
                      aria-current={activeSection === s.id ? "page" : undefined}
                      className="flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-sm font-medium text-slate-500 outline-none hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-brand-500 aria-[current=page]:bg-surface aria-[current=page]:text-brand-700 aria-[current=page]:shadow-sm"
                    >
                      <Icon size={16} stroke={1.7} />
                      {s.label}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}

        {activeSection === "security" ? (
          /* security section: its own flat nav, no product categories */
          <nav className="px-2 py-3">
            <ul className="flex flex-col gap-0.5">
              {securitySectionNav.map((n) => {
                const Icon = n.Icon;
                const active = n.exact ? pathname === n.to : navActive(n.to);
                return (
                  <li key={n.to}>
                    <Link
                      to={n.to}
                      title={collapsed ? n.label : undefined}
                      aria-current={active ? "page" : undefined}
                      className="flex items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 aria-[current=page]:bg-brand-50 aria-[current=page]:text-brand-700"
                    >
                      <Icon size={20} stroke={1.7} className="shrink-0" />
                      {!collapsed && <span className="shrink-0">{n.label}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        ) : (
          <>
            {/* flat group: Resources / Charts (active via navActive aria-current) */}
            <nav className="px-2 py-3">
              <ul className="flex flex-col gap-0.5">
                {[...navItems, ...(user.role === "admin" ? adminNavItems : [])].map((n) => {
                  const Icon = n.Icon;
                  return (
                    <li key={n.to}>
                      <Link
                        to={n.to}
                        title={collapsed ? n.label : undefined}
                        aria-current={navActive(n.to) ? "page" : undefined}
                        className="flex items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 aria-[current=page]:bg-brand-50 aria-[current=page]:text-brand-700"
                      >
                        <Icon size={20} stroke={1.7} className="shrink-0" />
                        {!collapsed && <span className="shrink-0">{n.label}</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>

            <div className="mx-3 border-t border-slate-100" />

        {/* product categories (dynamic: published charts with an order view) */}
        {collapsed ? (
          <nav className="flex flex-col gap-0.5 px-2 py-3">
            {menu.map((g) => {
              const Icon = categoryIcon(g.id);
              const first = g.charts[0];
              return (
                <Link
                  key={g.id}
                  to={first ? `/products/${first.project}/${first.name}` : "/catalog"}
                  title={g.label}
                  aria-current={activeCategory === g.id ? "page" : undefined}
                  className="flex rounded-md px-3 py-2 text-slate-600 hover:bg-slate-50 aria-[current=page]:bg-brand-50 aria-[current=page]:text-brand-700"
                >
                  <Icon size={20} stroke={1.7} />
                </Link>
              );
            })}
          </nav>
        ) : (
          <DisclosureGroup
            allowsMultipleExpanded
            expandedKeys={expanded}
            onExpandedChange={(keys) => setExpanded(new Set([...keys].map(String)))}
            className="px-2 py-3"
          >
            {menu.map((g) => {
              const Icon = categoryIcon(g.id);
              return (
                <Disclosure key={g.id} id={g.id} className="group">
                  <Heading>
                    <Button
                      slot="trigger"
                      className="flex w-full items-center justify-between whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-slate-600 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500"
                    >
                      <span className="flex items-center gap-3">
                        <Icon size={20} stroke={1.7} />
                        {g.label}
                      </span>
                      <IconChevronRight
                        size={16}
                        className="text-slate-400 transition-transform duration-200 group-data-[expanded]:rotate-90"
                      />
                    </Button>
                  </Heading>
                  <DisclosurePanel>
                    <ul className="ml-[22px] flex flex-col gap-0.5 border-l border-slate-100 py-1 pl-2">
                      {g.charts.map((c) => (
                        <li key={`${c.project}/${c.name}`}>
                          <Link
                            to={`/products/${c.project}/${c.name}`}
                            aria-current={chartActive(c) ? "page" : undefined}
                            className="block whitespace-nowrap rounded-md px-2 py-1.5 text-sm text-slate-500 hover:bg-slate-50 hover:text-slate-700 aria-[current=page]:bg-brand-50 aria-[current=page]:font-medium aria-[current=page]:text-brand-700"
                          >
                            {chartLabel(c.name)}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </DisclosurePanel>
                </Disclosure>
              );
            })}
          </DisclosureGroup>
            )}
          </>
        )}

        {/* collapse toggle */}
        <div className="mt-auto border-t border-slate-100 p-2">
          <Button
            onPress={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Развернуть меню" : "Свернуть меню"}
            aria-pressed={collapsed}
            className="flex w-full items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-sm text-slate-500 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {collapsed ? (
              <IconLayoutSidebarLeftExpand size={20} stroke={1.7} className="shrink-0" />
            ) : (
              <IconLayoutSidebarLeftCollapse size={20} stroke={1.7} className="shrink-0" />
            )}
            {!collapsed && <span className="shrink-0">Свернуть меню</span>}
          </Button>
        </div>
      </aside>

      {/* RIGHT COLUMN: topbar + content */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* TOPBAR */}
      <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-surface px-4">
        <OrgSelector />
        <div className="flex items-center gap-1">
          {/* System status is a platform-admin tool only. */}
          {user.role === "admin" && (
            <Link
              to="/status"
              aria-label="Статус системы"
              title="Статус системы"
              aria-current={pathname.startsWith("/status") ? "page" : undefined}
              className="rounded-md p-2 text-slate-500 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500 aria-[current=page]:bg-brand-50 aria-[current=page]:text-brand-700"
            >
              <IconActivity size={20} stroke={1.7} />
            </Link>
          )}
          <ThemeMenu />
          <Link
            to="/docs"
            aria-label="Документация"
            title="Документация"
            aria-current={pathname.startsWith("/docs") ? "page" : undefined}
            className="rounded-md p-2 text-slate-500 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500 aria-[current=page]:bg-brand-50 aria-[current=page]:text-brand-700"
          >
            <IconBook size={20} stroke={1.7} />
          </Link>
          <Link
            to="/about"
            aria-label="О портале"
            title="О портале"
            aria-current={pathname.startsWith("/about") ? "page" : undefined}
            className="rounded-md p-2 text-slate-500 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500 aria-[current=page]:bg-brand-50 aria-[current=page]:text-brand-700"
          >
            <IconInfoCircle size={20} stroke={1.7} />
          </Link>
          <IconButton label="Уведомления">
            <IconBell size={20} stroke={1.7} />
          </IconButton>
          <UserMenu />
        </div>
      </header>

        {/* MAIN - min-h-0 lets this flex child shrink below its content so its
            own overflow-y-auto scrolls instead of growing the page. relative
            makes it the containing block for react-aria's absolutely-positioned
            hidden nodes (VisuallyHidden/HiddenSelect) so they're clipped here
            instead of escaping to grow the document (whole-page scroll + phantom
            white block on the form). */}
        <main className="relative min-h-0 flex-1 overflow-y-auto p-6">
          {/* Constrain content width and center it: on wide screens rows don't
              stretch full width. h-full keeps the height chain intact (pages
              that stretch full height, e.g. the view builder). */}
          <div className={`mx-auto h-full w-full ${fullBleed ? "" : "max-w-screen-xl"}`}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

function OrgSelector() {
  const { team, teams, setTeam } = useTeam();
  if (teams.length === 0) {
    return (
      <span className="flex items-center gap-2 rounded-lg border border-dashed border-slate-200 px-3 py-1.5 text-sm text-slate-400">
        <IconUsersGroup size={18} stroke={1.7} />
        нет группы
      </span>
    );
  }
  // A single group can't be switched: show it as a static "current project" chip
  // (no chevron, no hover affordance) so it reads as context, not a control.
  if (teams.length === 1) {
    return (
      <span className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm">
        <IconUsersGroup size={18} stroke={1.7} className="text-brand-600" />
        <span className="text-slate-400">Проект:</span>
        <span className="font-semibold text-slate-800">{team}</span>
      </span>
    );
  }
  return (
    <DialogTrigger>
      <Button className="group flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm outline-none transition-colors hover:border-brand-300 hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-500 data-[pressed]:border-brand-300 data-[pressed]:bg-brand-50">
        <IconUsersGroup size={18} stroke={1.7} className="text-brand-600" />
        <span className="text-slate-400">Проект:</span>
        <span className="font-semibold text-slate-800">{team}</span>
        <IconChevronDown
          size={16}
          className="text-slate-400 transition-transform duration-200 group-hover:text-brand-500 group-data-[pressed]:rotate-180"
        />
      </Button>
      <ModalOverlay
        isDismissable
        className="fixed inset-0 z-10 flex items-start justify-center bg-black/20 p-4 pt-24 entering:animate-in entering:fade-in"
      >
        <Modal className="w-full max-w-md rounded-lg border border-slate-200 bg-surface shadow-xl">
          <Dialog className="outline-none">
            {({ close }) => (
              <>
                <div className="border-b border-slate-100 px-4 py-3">
                  <Heading slot="title" className="text-sm font-semibold text-slate-800">
                    Выбор группы
                  </Heading>
                  <p className="text-xs text-slate-500">Ваши team-* группы</p>
                </div>
                <ul className="max-h-72 overflow-auto p-2">
                  {teams.map((t) => (
                    <li key={t}>
                      <button
                        onClick={() => {
                          setTeam(t);
                          close();
                        }}
                        className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50"
                      >
                        <span className="flex items-center gap-3">
                          <IconUsersGroup size={18} stroke={1.7} className="text-brand-600" />
                          <span className="font-medium text-slate-800">{t}</span>
                        </span>
                        {t === team && <span className="text-xs text-brand-600">текущая</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </DialogTrigger>
  );
}

function IconButton({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <button
      aria-label={label}
      className="rounded-md p-2 text-slate-500 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      {children}
    </button>
  );
}

// Theme switcher: light / dark / RN. The choice is saved in localStorage and
// applied on <html data-theme> (see ThemeContext).
function ThemeMenu() {
  const { theme, setTheme } = useTheme();
  return (
    <MenuTrigger>
      <Button
        aria-label="Тема оформления"
        className="rounded-md p-2 text-slate-500 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <IconPalette size={20} stroke={1.7} />
      </Button>
      <Popover className="min-w-40 rounded-md border border-slate-200 bg-surface py-1 shadow-lg outline-none entering:animate-in entering:fade-in">
        <Menu className="outline-none" onAction={(key) => setTheme(key as Theme)}>
          {THEMES.map((t) => (
            <MenuItem
              key={t}
              id={t}
              className="flex cursor-pointer items-center justify-between gap-6 px-3 py-1.5 text-sm text-slate-700 outline-none focus:bg-slate-50"
            >
              {THEME_LABELS[t]}
              {theme === t && <IconCheck size={15} className="text-brand-600" />}
            </MenuItem>
          ))}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

function UserMenu() {
  const { user } = useUser();
  if (!user) return null;

  return (
    <MenuTrigger>
      <Button className="ml-2 flex items-center gap-2 rounded-md py-1 pl-1 pr-2 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-100 text-brand-700">
          <IconUser size={18} stroke={1.7} />
        </span>
        <span className="text-left text-xs leading-tight">
          <span className="block font-medium text-slate-800">{user.name || user.preferred_username}</span>
          <span className="block text-slate-400">{ROLE_LABELS[user.role] ?? user.role}</span>
        </span>
      </Button>
      <Popover className="min-w-44 rounded-md border border-slate-200 bg-surface py-1 shadow-lg outline-none entering:animate-in entering:fade-in">
        <Menu
          className="outline-none"
          onAction={(key) => {
            if (key === "logout") {
              window.location.href = api.logoutUrl();
            }
          }}
        >
          <MenuItem
            id="logout"
            className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-slate-700 outline-none focus:bg-slate-50"
          >
            <IconLogout size={16} stroke={1.7} />
            Выйти
          </MenuItem>
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

function LoginScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="rounded-lg border border-slate-200 bg-surface p-8 text-center shadow-sm">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-md bg-brand-600 text-on-accent">
          <IconCloud size={24} stroke={1.8} />
        </div>
        <h1 className="text-lg font-semibold text-slate-800">Console</h1>
        <p className="text-xs text-slate-400">Managed Services</p>
        <p className="mt-2 text-sm text-slate-500">Вы не аутентифицированы.</p>
        <a
          href={api.loginUrl(window.location.pathname + window.location.search)}
          className="mt-4 inline-block rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-on-accent hover:bg-brand-700"
        >
          Войти через Keycloak
        </a>
      </div>
    </div>
  );
}
