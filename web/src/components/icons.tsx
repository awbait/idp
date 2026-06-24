// Shared icon helpers built on @tabler/icons-react.

import {
  IconApps,
  IconBox,
  IconBrandMongodb,
  IconBrandMysql,
  IconBucket,
  IconChartLine,
  IconCloud,
  IconCpu,
  IconDatabase,
  IconKey,
  IconLock,
  IconMessages,
  IconNetwork,
  IconServer,
  IconShieldLock,
  IconStack2,
  IconStack3,
} from "@tabler/icons-react";
import type { ComponentType } from "react";

// Common shape of a Tabler icon component (size/stroke/className props).
export type TablerIcon = ComponentType<{ size?: number | string; stroke?: number; className?: string }>;

// Category icon palette: the admin picks one of these by slug (stored on the
// category in the DB); icons are pure cosmetics. Keep the keys stable - they are
// persisted. The "platform"/"databases"/"network" aliases keep older categories
// (seeded before the icon field) showing a sensible icon until re-picked.
const CATEGORY_ICON_BY_NAME: Record<string, TablerIcon> = {
  box: IconBox,
  stack: IconStack3,
  database: IconDatabase,
  network: IconNetwork,
  server: IconServer,
  cloud: IconCloud,
  shield: IconShieldLock,
  lock: IconLock,
  key: IconKey,
  chart: IconChartLine,
  bucket: IconBucket,
  cpu: IconCpu,
  apps: IconApps,
  messages: IconMessages,
  // legacy id aliases (pre-icon-field categories)
  platform: IconStack3,
  databases: IconDatabase,
};

// CATEGORY_ICON_CHOICES drives the icon picker (the real palette, without the
// legacy id aliases).
export const CATEGORY_ICON_CHOICES: { id: string; Icon: TablerIcon }[] = [
  "box",
  "stack",
  "database",
  "network",
  "server",
  "cloud",
  "shield",
  "lock",
  "key",
  "chart",
  "bucket",
  "cpu",
  "apps",
  "messages",
].map((id) => ({ id, Icon: CATEGORY_ICON_BY_NAME[id] }));

// categoryIcon resolves a category's chosen icon slug to a component (default
// for empty/unknown).
export function categoryIcon(name: string): TablerIcon {
  return CATEGORY_ICON_BY_NAME[name] ?? IconBox;
}

// Map a chart/product name to a Tabler icon (brand where available, else by kind).
const PRODUCT_ICON: Record<string, TablerIcon> = {
  postgres: IconDatabase,
  postgresql: IconDatabase,
  redis: IconDatabase,
  clickhouse: IconDatabase,
  elasticsearch: IconDatabase,
  mongo: IconBrandMongodb,
  mongodb: IconBrandMongodb,
  mysql: IconBrandMysql,
  mariadb: IconBrandMysql,
  kafka: IconStack2,
  rabbitmq: IconStack2,
  nginx: IconServer,
  grafana: IconChartLine,
  prometheus: IconChartLine,
  minio: IconBucket,
};

function iconFor(name: string): TablerIcon {
  const n = name.toLowerCase();
  for (const key of Object.keys(PRODUCT_ICON)) {
    if (n.includes(key)) return PRODUCT_ICON[key];
  }
  return IconBox;
}

export function ProductIcon({
  name,
  size = 18,
  className = "",
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const Icon = iconFor(name);
  return <Icon size={size} stroke={1.7} className={`shrink-0 ${className}`} />;
}
