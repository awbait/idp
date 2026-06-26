import {
  IconAlertTriangle,
  IconArrowRight,
  IconBox,
  IconCircleCheck,
  IconGitFork,
  IconLifebuoy,
  IconLoader2,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import { Link, Outlet } from "react-router-dom";
import { api } from "../api/client";
import type { OrderRequest, RequestStatus } from "../api/types";
import { useUser } from "../auth/UserContext";
import { ProductIcon } from "../components/icons";
import { OrdersTable } from "../components/OrdersTable";
import { StatusBadge } from "../components/StatusBadge";
import { ErrorBox, Spinner } from "../components/ui";
import { useAsync } from "../hooks/useAsync";

// SupportSection guards every /support/* route: only the support role and
// platform admins may enter. Support is a cross-team role - it sees and helps
// with the orders of all teams, so this section is not scoped to a team.
export function SupportSection() {
  const { user } = useUser();
  if (user?.role !== "support" && user?.role !== "admin") {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        Раздел доступен только сотрудникам поддержки.
      </div>
    );
  }
  return <Outlet />;
}

// ---------------------------------------------------------------------------
// shared visual bits
// ---------------------------------------------------------------------------

const TONE = {
  emerald: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-red-700",
  slate: "bg-slate-100 text-slate-600",
  brand: "bg-brand-50 text-brand-700",
} as const;
type Tone = keyof typeof TONE;

function StatCard({
  label,
  value,
  tone,
  Icon,
}: {
  label: string;
  value: ReactNode;
  tone: Tone;
  Icon: typeof IconBox;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-surface p-4 shadow-sm">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${TONE[tone]}`}>
        <Icon size={20} stroke={1.8} />
      </span>
      <div className="min-w-0">
        <div className="text-2xl font-semibold leading-tight text-slate-900">{value}</div>
        <div className="truncate text-xs text-slate-500">{label}</div>
      </div>
    </div>
  );
}

// Live (deployed or deploying) order statuses - these represent real services.
const LIVE: RequestStatus[] = ["MR_MERGED", "DEPLOYING", "HEALTHY", "DEGRADED", "ARGO_MISSING"];
// Statuses that signal an unhealthy deployment a supporter should look into.
const UNHEALTHY: RequestStatus[] = ["DEGRADED", "ARGO_MISSING"];

function needsAttention(r: OrderRequest): boolean {
  return UNHEALTHY.includes(r.status) || r.drifted;
}

// ---------------------------------------------------------------------------
// Overview - real data across all teams
// ---------------------------------------------------------------------------

export function SupportOverviewPage() {
  const { data, error, loading } = useAsync(() => api.listRequests(), []);
  if (loading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;

  const orders = data ?? [];
  const live = orders.filter((r) => LIVE.includes(r.status));
  const healthy = orders.filter((r) => r.status === "HEALTHY").length;
  const deploying = orders.filter((r) => r.status === "DEPLOYING" || r.status === "MR_CREATED").length;
  const attention = orders.filter(needsAttention);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Обзор поддержки</h1>
        <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${TONE.brand}`}>
          <IconLifebuoy size={13} stroke={1.8} /> Все команды
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Сервисов всего" value={live.length} tone="brand" Icon={IconBox} />
        <StatCard label="Работают" value={healthy} tone="emerald" Icon={IconCircleCheck} />
        <StatCard label="Требуют внимания" value={attention.length} tone="red" Icon={IconAlertTriangle} />
        <StatCard label="В процессе" value={deploying} tone="amber" Icon={IconLoader2} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* attention list */}
        <div className="rounded-lg border border-slate-200 bg-surface p-4 shadow-sm lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-slate-800">Требуют внимания</h2>
          {attention.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">
              Все сервисы в порядке - проблемных и расходящихся с Git заказов нет.
            </p>
          ) : (
            <ul className="flex flex-col">
              {attention.slice(0, 8).map((r) => (
                <li key={r.id} className="border-b border-slate-100 last:border-0">
                  <Link
                    to={`/requests/${r.id}`}
                    className="flex items-center gap-3 py-2.5 outline-none hover:bg-slate-50 focus-visible:bg-slate-50"
                  >
                    <ProductIcon project={r.chart_project} name={r.chart_name} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-800">{r.service_name}</p>
                      <p className="truncate text-xs text-slate-400">
                        {r.team} / {r.chart_name}
                      </p>
                    </div>
                    {r.drifted && (
                      <span className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-700">
                        <IconGitFork size={12} stroke={2} /> Git
                      </span>
                    )}
                    <StatusBadge status={r.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {attention.length > 8 && (
            <p className="mt-2 text-xs text-slate-400">и ещё {attention.length - 8}...</p>
          )}
        </div>

        {/* quick link to the full cross-team list */}
        <div className="flex flex-col gap-4">
          <Link
            to="/support/requests"
            className="group flex items-center justify-between rounded-lg border border-slate-200 bg-surface p-4 shadow-sm outline-none hover:border-brand-300 hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <span className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                <IconBox size={18} stroke={1.8} />
              </span>
              <span>
                <span className="block text-sm font-medium text-slate-800">Заказы всех команд</span>
                <span className="block text-xs text-slate-500">{orders.length} заказов</span>
              </span>
            </span>
            <IconArrowRight size={18} className="text-slate-300 group-hover:text-brand-500" />
          </Link>

          <div className="rounded-lg border border-slate-200 bg-surface p-4 text-xs text-slate-500 shadow-sm">
            Поддержка видит и помогает с заказами всех команд: можно открыть заказ, изменить его
            параметры или обновить версию. Создание и удаление остаются за командами-владельцами.
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cross-team orders list
// ---------------------------------------------------------------------------

export function SupportRequestsPage() {
  return <OrdersTable title="Заказы всех команд" allTeams />;
}
