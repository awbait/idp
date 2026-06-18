import type { ReactNode } from "react";
import { Link, Outlet } from "react-router-dom";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconExternalLink,
  IconScan,
  IconShieldCheck,
  IconShieldLock,
} from "@tabler/icons-react";
import { useUser } from "../auth/UserContext";

// NOTE: the security section is a visual mock for now - all data below is
// hardcoded and no requests are made. It exists to show how the screens could
// look once the policies service and Kyverno integration land.

// SecuritySection guards every /security/* route: only the security (InfoSec)
// role and platform admins may enter. The child pages render via <Outlet />.
export function SecuritySection() {
  const { user } = useUser();
  if (user?.role !== "security" && user?.role !== "admin") {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        Раздел доступен только сотрудникам информационной безопасности.
      </div>
    );
  }
  return <Outlet />;
}

// ---------------------------------------------------------------------------
// shared visual bits
// ---------------------------------------------------------------------------

const TONE = {
  emerald: { card: "bg-emerald-50 text-emerald-700", badge: "bg-emerald-50 text-emerald-700" },
  amber: { card: "bg-amber-50 text-amber-700", badge: "bg-amber-50 text-amber-700" },
  red: { card: "bg-red-50 text-red-700", badge: "bg-red-50 text-red-700" },
  slate: { card: "bg-slate-100 text-slate-600", badge: "bg-slate-100 text-slate-600" },
  brand: { card: "bg-brand-50 text-brand-700", badge: "bg-brand-50 text-brand-700" },
} as const;
type Tone = keyof typeof TONE;

function StatCard({
  label,
  value,
  hint,
  tone,
  Icon,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone: Tone;
  Icon: typeof IconClock;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-surface p-4 shadow-sm">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${TONE[tone].card}`}>
        <Icon size={20} stroke={1.8} />
      </span>
      <div className="min-w-0">
        <div className="text-2xl font-semibold leading-tight text-slate-900">{value}</div>
        <div className="truncate text-xs text-slate-500">{label}</div>
        {hint && <div className="truncate text-[11px] text-slate-400">{hint}</div>}
      </div>
    </div>
  );
}

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${TONE[tone].badge}`}>
      {children}
    </span>
  );
}

function MockNote() {
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
      <IconAlertTriangle size={14} stroke={1.8} className="shrink-0 text-slate-400" />
      Демо-данные. Реальная интеграция появится вместе с сервисом policies.
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

const RECENT = [
  { actor: "Ivy Security", text: "согласовала политику team-payments / payments-gateway", time: "10 минут назад", tone: "emerald" as Tone },
  { actor: "Ivy Security", text: "отклонила политику team-core / core-netpol (слишком широкий ingress)", time: "1 час назад", tone: "red" as Tone },
  { actor: "Kyverno", text: "обнаружено 2 нарушения require-run-as-non-root в namespace payments", time: "3 часа назад", tone: "amber" as Tone },
  { actor: "Ivy Security", text: "согласовала политику team-dbaas / dbaas-restrict", time: "вчера, 18:30", tone: "emerald" as Tone },
];

export function SecurityOverviewPage() {
  const pass = 142;
  const warn = 8;
  const fail = 5;
  const total = pass + warn + fail;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Обзор ИБ</h1>
        <Badge tone="brand">
          <IconShieldLock size={13} stroke={1.8} /> InfoSec
        </Badge>
      </div>
      <MockNote />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Ждут согласования" value={3} tone="amber" Icon={IconClock} />
        <StatCard label="Согласовано за неделю" value={12} tone="emerald" Icon={IconShieldCheck} />
        <StatCard label="Активных политик" value={28} tone="brand" Icon={IconScan} />
        <StatCard label="Нарушений за 24ч" value={5} tone="red" Icon={IconAlertTriangle} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* recent activity */}
        <div className="rounded-lg border border-slate-200 bg-surface p-4 shadow-sm lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold text-slate-800">Последние события</h2>
          <ul className="flex flex-col">
            {RECENT.map((e, i) => (
              <li
                key={i}
                className="flex items-start gap-3 border-b border-slate-100 py-2.5 last:border-0"
              >
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE[e.tone].card}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-700">
                    <span className="font-medium text-slate-900">{e.actor}</span> {e.text}
                  </p>
                  <p className="text-xs text-slate-400">{e.time}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* compliance + quick links */}
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-slate-200 bg-surface p-4 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold text-slate-800">Соответствие политикам</h2>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div className="bg-emerald-500" style={{ width: `${(pass / total) * 100}%` }} />
              <div className="bg-amber-400" style={{ width: `${(warn / total) * 100}%` }} />
              <div className="bg-red-500" style={{ width: `${(fail / total) * 100}%` }} />
            </div>
            <div className="mt-3 flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 text-slate-600">
                <span className="h-2 w-2 rounded-full bg-emerald-500" /> Pass {pass}
              </span>
              <span className="flex items-center gap-1.5 text-slate-600">
                <span className="h-2 w-2 rounded-full bg-amber-400" /> Warn {warn}
              </span>
              <span className="flex items-center gap-1.5 text-slate-600">
                <span className="h-2 w-2 rounded-full bg-red-500" /> Fail {fail}
              </span>
            </div>
          </div>

          <Link
            to="/security/policies"
            className="group flex items-center justify-between rounded-lg border border-slate-200 bg-surface p-4 shadow-sm outline-none hover:border-brand-300 hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <span className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
                <IconShieldCheck size={18} stroke={1.8} />
              </span>
              <span>
                <span className="block text-sm font-medium text-slate-800">Согласование политик</span>
                <span className="block text-xs text-slate-500">3 в очереди</span>
              </span>
            </span>
            <IconArrowRight size={18} className="text-slate-300 group-hover:text-brand-500" />
          </Link>

          <Link
            to="/security/kyverno"
            className="group flex items-center justify-between rounded-lg border border-slate-200 bg-surface p-4 shadow-sm outline-none hover:border-brand-300 hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <span className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                <IconScan size={18} stroke={1.8} />
              </span>
              <span>
                <span className="block text-sm font-medium text-slate-800">Kyverno UI</span>
                <span className="block text-xs text-slate-500">отчёты по политикам кластера</span>
              </span>
            </span>
            <IconArrowRight size={18} className="text-slate-300 group-hover:text-brand-500" />
          </Link>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Policy approval queue
// ---------------------------------------------------------------------------

type PolicyStatus = "PENDING" | "APPROVED" | "REJECTED";

const POLICY_BADGE: Record<PolicyStatus, { label: string; tone: Tone }> = {
  PENDING: { label: "На согласовании", tone: "amber" },
  APPROVED: { label: "Согласовано", tone: "emerald" },
  REJECTED: { label: "Отклонено", tone: "red" },
};

const POLICY_ROWS: {
  service: string;
  team: string;
  author: string;
  date: string;
  rules: number;
  status: PolicyStatus;
}[] = [
  { service: "payments-gateway", team: "payments", author: "Alice Dev", date: "сегодня, 14:20", rules: 4, status: "PENDING" },
  { service: "core-netpol", team: "core", author: "Bob Ops", date: "сегодня, 11:05", rules: 2, status: "PENDING" },
  { service: "dbaas-restrict", team: "dbaas", author: "Carol Lee", date: "вчера, 18:30", rules: 6, status: "PENDING" },
  { service: "core-psp-baseline", team: "core", author: "Alice Dev", date: "12 июня, 09:12", rules: 3, status: "APPROVED" },
  { service: "payments-egress", team: "payments", author: "Dan Roe", date: "11 июня, 16:40", rules: 5, status: "REJECTED" },
];

export function PolicyApprovalPage() {
  const pending = POLICY_ROWS.filter((r) => r.status === "PENDING").length;
  const filters = [
    { label: "Все", count: POLICY_ROWS.length, active: true },
    { label: "Ожидают", count: pending, active: false },
    { label: "Согласованные", count: POLICY_ROWS.filter((r) => r.status === "APPROVED").length, active: false },
    { label: "Отклонённые", count: POLICY_ROWS.filter((r) => r.status === "REJECTED").length, active: false },
  ];
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Согласование политик</h1>
        <Badge tone="amber">{pending} в очереди</Badge>
      </div>
      <MockNote />

      <div className="flex flex-wrap gap-2">
        {filters.map((f) => (
          <button
            key={f.label}
            type="button"
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
              f.active
                ? "border-brand-200 bg-brand-50 text-brand-700"
                : "border-slate-200 bg-surface text-slate-600 hover:bg-slate-50"
            }`}
          >
            {f.label}
            <span className="rounded-full bg-white/70 px-1.5 text-[11px] text-slate-500">{f.count}</span>
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-surface shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2.5 font-medium">Сервис</th>
              <th className="px-4 py-2.5 font-medium">Команда</th>
              <th className="px-4 py-2.5 font-medium">Автор</th>
              <th className="px-4 py-2.5 font-medium">Правил</th>
              <th className="px-4 py-2.5 font-medium">Дата</th>
              <th className="px-4 py-2.5 font-medium">Статус</th>
              <th className="px-4 py-2.5 text-right font-medium">Действия</th>
            </tr>
          </thead>
          <tbody>
            {POLICY_ROWS.map((r) => {
              const badge = POLICY_BADGE[r.status];
              return (
                <tr key={r.service} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2 font-medium text-slate-800">
                      <IconShieldCheck size={16} stroke={1.7} className="text-slate-400" />
                      {r.service}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{r.team}</td>
                  <td className="px-4 py-3 text-slate-600">{r.author}</td>
                  <td className="px-4 py-3 text-slate-600">{r.rules}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500">{r.date}</td>
                  <td className="px-4 py-3">
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      {r.status === "PENDING" ? (
                        <>
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 outline-none hover:bg-emerald-100 focus-visible:ring-2 focus-visible:ring-emerald-500"
                          >
                            <IconCircleCheck size={14} stroke={1.8} /> Согласовать
                          </button>
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700 outline-none hover:bg-red-100 focus-visible:ring-2 focus-visible:ring-red-500"
                          >
                            <IconCircleX size={14} stroke={1.8} /> Отклонить
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-surface px-2.5 py-1 text-xs font-medium text-slate-600 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500"
                        >
                          Открыть
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kyverno UI (policy reports)
// ---------------------------------------------------------------------------

const SEVERITY: Record<string, Tone> = { high: "red", medium: "amber", low: "slate" };

const KYVERNO_ROWS: {
  name: string;
  category: string;
  severity: keyof typeof SEVERITY;
  pass: number;
  fail: number;
}[] = [
  { name: "require-run-as-non-root", category: "Pod Security", severity: "high", pass: 48, fail: 2 },
  { name: "disallow-latest-tag", category: "Best Practices", severity: "medium", pass: 51, fail: 0 },
  { name: "require-requests-limits", category: "Resources", severity: "medium", pass: 40, fail: 5 },
  { name: "restrict-image-registries", category: "Supply Chain", severity: "high", pass: 53, fail: 0 },
  { name: "require-network-policy", category: "Networking", severity: "low", pass: 30, fail: 3 },
  { name: "disallow-privileged", category: "Pod Security", severity: "high", pass: 53, fail: 0 },
];

export function KyvernoPage() {
  const pass = KYVERNO_ROWS.reduce((n, r) => n + r.pass, 0);
  const fail = KYVERNO_ROWS.reduce((n, r) => n + r.fail, 0);
  const namespaces = ["все namespaces", "payments", "core", "dbaas", "platform"];
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-slate-900">Kyverno UI</h1>
          <Badge tone="brand">Policy Reporter</Badge>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-surface px-3 py-1.5 text-sm text-slate-600 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <IconExternalLink size={16} stroke={1.8} /> Открыть в отдельном окне
        </button>
      </div>
      <MockNote />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Pass" value={pass} tone="emerald" Icon={IconCircleCheck} />
        <StatCard label="Fail" value={fail} tone="red" Icon={IconCircleX} />
        <StatCard label="Warn" value={8} tone="amber" Icon={IconAlertTriangle} />
        <StatCard label="Политик" value={KYVERNO_ROWS.length} tone="slate" Icon={IconScan} />
      </div>

      <div className="flex flex-wrap gap-2">
        {namespaces.map((ns, i) => (
          <button
            key={ns}
            type="button"
            className={`rounded-full border px-3 py-1 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
              i === 0
                ? "border-brand-200 bg-brand-50 text-brand-700"
                : "border-slate-200 bg-surface text-slate-600 hover:bg-slate-50"
            }`}
          >
            {ns}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-surface shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-2.5 font-medium">Политика</th>
              <th className="px-4 py-2.5 font-medium">Категория</th>
              <th className="px-4 py-2.5 font-medium">Severity</th>
              <th className="px-4 py-2.5 font-medium">Результат</th>
              <th className="px-4 py-2.5 text-right font-medium">Статус</th>
            </tr>
          </thead>
          <tbody>
            {KYVERNO_ROWS.map((r) => {
              const ok = r.fail === 0;
              return (
                <tr key={r.name} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-800">{r.name}</td>
                  <td className="px-4 py-3 text-slate-600">{r.category}</td>
                  <td className="px-4 py-3">
                    <Badge tone={SEVERITY[r.severity]}>{r.severity}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-3 text-xs">
                      <span className="text-emerald-600">{r.pass} pass</span>
                      <span className={r.fail > 0 ? "text-red-600" : "text-slate-400"}>{r.fail} fail</span>
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      {ok ? (
                        <Badge tone="emerald">
                          <IconCircleCheck size={13} stroke={1.8} /> pass
                        </Badge>
                      ) : (
                        <Badge tone="red">
                          <IconCircleX size={13} stroke={1.8} /> fail
                        </Badge>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
