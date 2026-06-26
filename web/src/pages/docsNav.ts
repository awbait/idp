import {
  IconBucket,
  IconDatabase,
  IconMessages,
  IconNetwork,
  IconServer,
  IconStack2,
} from "@tabler/icons-react";
import type { ComponentType } from "react";

type IconType = ComponentType<{ size?: number; stroke?: number; className?: string }>;

// Docs navigation, defined in TS instead of a markdown manifest: it is a small,
// rarely-changing tree, and TS gives us types, prev/next ordering and collapsible
// subgroups for free. A node is either a leaf link (a page) or a group of nodes.
// Top-level groups are sections (always shown); nested groups are collapsible and
// may carry an icon.
export type DocLink = { kind: "link"; id: string; title: string };
export type DocGroup = { kind: "group"; title: string; children: DocNode[]; Icon?: IconType };
export type DocNode = DocLink | DocGroup;

const link = (id: string, title: string): DocLink => ({ kind: "link", id, title });

export const DOCS_NAV: DocGroup[] = [
  {
    kind: "group",
    title: "Начало работы",
    children: [link("index", "Обзор портала"), link("quick-start", "Быстрый старт")],
  },
  {
    kind: "group",
    title: "Устройство платформы",
    children: [
      link("roles", "Роли и доступы"),
      link("architecture", "Архитектура и интеграции"),
      link("git-structure", "Структура сервисов в Git"),
    ],
  },
  {
    kind: "group",
    title: "Работа с сервисами",
    children: [
      link("catalog", "Каталог сервисов"),
      link("ordering", "Заказ сервиса"),
      link("statuses", "Статусы и развёртывание"),
      link("publishing", "Публикация сервиса"),
    ],
  },
  {
    kind: "group",
    title: "Администрирование",
    children: [
      link("support", "Панель поддержки"),
      link("admin", "Панель администратора"),
      link("security", "Информационная безопасность"),
    ],
  },
  {
    kind: "group",
    title: "Управляемые сервисы",
    children: [
      {
        kind: "group",
        title: "Сеть",
        Icon: IconNetwork,
        children: [
          link("ingress-gateway", "Ingress Gateway"),
          link("egress-gateway", "Egress Gateway"),
          link("policy", "Policies"),
        ],
      },
      {
        kind: "group",
        title: "Платформа",
        Icon: IconStack2,
        children: [link("namespace", "Namespace"), link("project", "Project")],
      },
      {
        kind: "group",
        title: "Базы данных",
        Icon: IconDatabase,
        children: [
          link("postgresql-zalando", "PostgreSQL (Zalando)"),
          link("postgresql-cnpg", "PostgreSQL (CNPG)"),
          link("clickhouse", "ClickHouse"),
          link("valkey", "Valkey"),
        ],
      },
      {
        kind: "group",
        title: "Брокеры сообщений",
        Icon: IconMessages,
        children: [link("rabbitmq", "RabbitMQ"), link("kafka", "Kafka")],
      },
      {
        kind: "group",
        title: "Хранилище",
        Icon: IconBucket,
        children: [link("s3-bucket", "S3 Bucket")],
      },
      {
        kind: "group",
        title: "Инфраструктура",
        Icon: IconServer,
        children: [link("virtual-machines", "Virtual Machines")],
      },
    ],
  },
  {
    kind: "group",
    title: "Справка",
    children: [
      link("faq", "Частые вопросы"),
      // TODO: временно, потом удалить - бизнес-документ (польза/экономия) не для пользователей портала.
      link("value-and-savings", "Польза и экономия"),
    ],
  },
];

// A flat list of every page in nav order, each tagged with its top-level
// section (used for the search index, prev/next, and the default landing page).
export type FlatDoc = { id: string; title: string; section: string };

export function flattenNav(): FlatDoc[] {
  const out: FlatDoc[] = [];
  const walk = (node: DocNode, section: string) => {
    if (node.kind === "link") out.push({ id: node.id, title: node.title, section });
    else for (const child of node.children) walk(child, section);
  };
  for (const sec of DOCS_NAV) walk(sec, sec.title);
  return out;
}

// The chain of nested-group titles (full ">"-joined keys) leading to a page, so
// the nav can auto-expand the subgroups that contain the active page.
export function pathToActive(activeId: string): string[] {
  const find = (nodes: DocNode[], parentKey: string): string[] | null => {
    for (const node of nodes) {
      if (node.kind === "link") {
        if (node.id === activeId) return [];
        continue;
      }
      const key = parentKey ? `${parentKey}>${node.title}` : node.title;
      const sub = find(node.children, key);
      if (sub) return [key, ...sub];
    }
    return null;
  };
  return find(DOCS_NAV, "") ?? [];
}
