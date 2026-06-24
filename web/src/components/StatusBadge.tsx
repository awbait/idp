import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconCloudOff,
  IconGitMerge,
  IconGitPullRequest,
  IconGitPullRequestClosed,
  IconLoader2,
  IconPencil,
  IconRocket,
  IconTrash,
  IconTrashX,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import type { RequestStatus } from "../api/types";

type IconType = ComponentType<{ size?: number; stroke?: number; className?: string }>;

// Per-status presentation: a distinct icon (shape, not just colour), a colour,
// and a short human label. Shape carries the meaning so statuses are legible
// even at a glance or for colour-blind users.
interface StatusMeta {
  label: string; // human-readable (RU)
  Icon: IconType;
  fg: string; // icon/text colour
  badge: string; // pill background + text
  spin?: boolean;
  staticIcon?: IconType; // non-animated stand-in for spinning statuses (e.g. timeline)
}

const META: Record<string, StatusMeta> = {
  DRAFT: { label: "Черновик", Icon: IconPencil, fg: "text-slate-500", badge: "bg-slate-100 text-slate-700" },
  MR_CREATED: { label: "MR открыт", Icon: IconGitPullRequest, fg: "text-amber-600", badge: "bg-amber-100 text-amber-800" },
  MR_MERGED: { label: "MR влит", Icon: IconGitMerge, fg: "text-indigo-600", badge: "bg-indigo-100 text-indigo-800" },
  MR_CLOSED: { label: "MR закрыт", Icon: IconGitPullRequestClosed, fg: "text-slate-500", badge: "bg-slate-200 text-slate-600" },
  DEPLOYING: { label: "Деплой", Icon: IconLoader2, fg: "text-blue-600", badge: "bg-blue-100 text-blue-800", spin: true, staticIcon: IconRocket },
  HEALTHY: { label: "Healthy", Icon: IconCircleCheck, fg: "text-emerald-600", badge: "bg-green-100 text-green-800" },
  DEGRADED: { label: "Degraded", Icon: IconAlertTriangle, fg: "text-red-600", badge: "bg-red-100 text-red-800" },
  ARGO_MISSING: { label: "Нет в ArgoCD", Icon: IconCloudOff, fg: "text-red-600", badge: "bg-red-100 text-red-800" },
  DELETE_REQUESTED: { label: "Удаление", Icon: IconTrash, fg: "text-orange-600", badge: "bg-orange-100 text-orange-800" },
  DELETE_MR_MERGED: { label: "Удаление (влито)", Icon: IconTrashX, fg: "text-orange-600", badge: "bg-orange-100 text-orange-800" },
  DELETED: { label: "Удалён", Icon: IconCircleX, fg: "text-slate-400", badge: "bg-gray-200 text-gray-600" },
};

function metaFor(status: string): StatusMeta {
  return (
    META[status] ?? {
      label: status,
      Icon: IconLoader2,
      fg: "text-slate-500",
      badge: "bg-gray-100 text-gray-700",
    }
  );
}

// statusMeta exposes a status's presentation (icon, colour, label) so other
// views (e.g. the activity timeline) can render it consistently.
export function statusMeta(status: string): StatusMeta {
  return metaFor(status);
}

export function StatusBadge({
  status,
  muted,
  noSpin,
}: {
  status: RequestStatus | string;
  muted?: boolean;
  // Disable the live spinner (e.g. in the history timeline, where a status is a
  // past record rather than the current live state).
  noSpin?: boolean;
}) {
  const m = metaFor(status);
  const Icon = noSpin && m.staticIcon ? m.staticIcon : m.Icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        muted ? "bg-slate-100 text-slate-400" : m.badge
      }`}
    >
      <Icon size={13} stroke={2} className={m.spin && !noSpin ? "animate-spin" : undefined} />
      {m.label}
    </span>
  );
}

// Status as a single colored icon (label exposed via title/aria-label). Distinct
// shapes make each status recognizable in the compact orders table.
export function StatusDot({ status, size = 22 }: { status: RequestStatus | string; size?: number }) {
  const m = metaFor(status);
  return (
    <span title={m.label} aria-label={m.label} className="inline-flex">
      <m.Icon size={size} stroke={2} className={`${m.fg} ${m.spin ? "animate-spin" : ""}`} />
    </span>
  );
}
