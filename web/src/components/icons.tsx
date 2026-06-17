// Shared icon helpers built on @tabler/icons-react.
import type { ComponentType } from "react";
import {
  IconBox,
  IconBrandMongodb,
  IconBrandMysql,
  IconBucket,
  IconChartLine,
  IconDatabase,
  IconNetwork,
  IconServer,
  IconStack2,
  IconStack3,
} from "@tabler/icons-react";

// Common shape of a Tabler icon component (size/stroke/className props).
export type TablerIcon = ComponentType<{ size?: number | string; stroke?: number; className?: string }>;

// Catalog category icon by its slug (categories live in the DB and are managed
// by an admin; icons are client-side cosmetics with a default for unknown slugs).
const CATEGORY_ICONS: Record<string, TablerIcon> = {
  platform: IconStack3,
  databases: IconDatabase,
  network: IconNetwork,
};

export function categoryIcon(id: string): TablerIcon {
  return CATEGORY_ICONS[id] ?? IconBox;
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
