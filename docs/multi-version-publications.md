# Несколько опубликованных версий сервиса

Дизайн-документ фичи «у сервиса (чарта) может быть несколько опубликованных
версий». Цель: владелец публикует и согласует несколько версий чарта (каждая со
своим view-документом), помечает, какие доступны пользователю для заказа
(allowlist) и какая рекомендуемая; пользователь при заказе выбирает версию.

Статус: план зафиксирован, реализация - отдельными PR по фазам (см. ниже).
Объём - полный (включая явный выбор рекомендуемой версии владельцем и per-version
конструктор view).

## Текущее состояние (что меняем)

Везде зашито допущение **1 публикация = 1 чарт = 1 view = 1 согласованная
версия**:

- БД: `chart_publications` с `UNIQUE(chart_project, chart_name)` и одиночными
  колонками `approved_view_json` / `approved_view_version` /
  `approved_description` / `approved_icon_url`
  (`internal/store/migrations/000006_publications.sql`, `000008..000010`).
- Модель: одиночные `ApprovedView*` поля, `Published()` по одному view
  (`pkg/models/publications.go`).
- FSM: `review` перетирает единственный approved view и стампит latest-версию
  (`internal/publications/service.go`).
- `ActiveView` отдаёт один approved view без выбора версии.
- Каталог API: `publicationSummary.ApprovedViewVersion` (одно поле), нет списка
  версий / счётчика / allowlist (`internal/api/handlers_publications.go`).
- `/charts/{project}/{name}/view` без параметра версии.
- Заказ: новый заказ всегда `latest_version`, `getChartView` без версии,
  identity/defaults из единственного view (`internal/provisioning/service.go`,
  `web/src/pages/OrderPage.tsx`).
- Каталог-фронт: один чип версии (`web/src/pages/CatalogPage.tsx`).
- Конструктор view привязан к latest-версии (`web/src/pages/ChartManagePage.tsx`).

## Модель данных

`chart_publications` остаётся **сервисом** (владелец, категория, координаты
чарта, draft-метаданные). Версии выносятся в новую таблицу (1:N).

```sql
CREATE TABLE publication_versions (
  id                  UUID PRIMARY KEY,
  publication_id      UUID NOT NULL REFERENCES chart_publications(id) ON DELETE CASCADE,
  chart_version       TEXT NOT NULL,          -- версия чарта в Harbor
  view_json           JSONB,                  -- черновик view под эту версию
  approved_view_json  JSONB,                  -- согласованный view этой версии
  status              TEXT NOT NULL,          -- DRAFT|PENDING|APPROVED|REJECTED (FSM на версию)
  orderable           BOOLEAN NOT NULL DEFAULT false, -- allowlist: доступна для заказа
  approved_description TEXT,                  -- снапшоты на момент approve
  approved_icon_url   TEXT,
  version             INT NOT NULL DEFAULT 0, -- optimistic lock
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (publication_id, chart_version)
);
```

Рекомендуемая версия: колонка `recommended_version TEXT` на `chart_publications`
(nullable). Если не задана или указывает на неактуальную - фолбэк: максимальная
`orderable AND status=APPROVED` версия.

`Published()` для сервиса: существует хотя бы одна версия с
`status=APPROVED AND orderable AND` наличием `views.order`.

### Миграция и бэкфилл

Новая миграция:
1. Создать `publication_versions` и добавить `recommended_version` в
   `chart_publications`.
2. Бэкфилл: для каждой публикации с непустым `approved_view_json` создать одну
   строку версии (`chart_version = approved_view_version`,
   `approved_view_json/description/icon` перенести, `status=APPROVED`,
   `orderable=true`); проставить `recommended_version = approved_view_version`.
   Черновой `view_json` без approved перенести как `status=DRAFT` строку под
   latest-версию (или оставить в публикации до первого submit - уточнить при
   реализации).
3. Старые колонки `approved_*` оставить на переходный период (читать перестаём),
   удалить отдельной поздней миграцией.

## Бэкенд

- **Модель** (`pkg/models/publications.go`): `PublicationVersion`;
  `ChartPublication` получает `RecommendedVersion` и (в проекциях) список версий.
- **Store** (`internal/store/store.go`, `postgres_publications.go`,
  `memory_publications.go`): симметрично добавить
  `ListVersions(pubID)`, `GetVersion(pubID, chartVersion)`,
  `UpsertVersion`, `SetOrderable`, `SetRecommended`, и обновить scan/cols.
- **FSM по версии** (`internal/publications/service.go`):
  - submit/approve/reject относятся к **конкретной версии**; approve пишет
    `approved_view_json` именно этой строки, больше не перетирает «единственный».
  - `validateView` валидирует против схемы **этой версии** (`GetSchema(version)`,
    не `LatestSchema`).
  - `ActiveView(project, name, version)` - approved view выбранной версии;
    фолбэк - рекомендуемая.
  - владелец переключает `orderable` (allowlist) и `recommended_version`.
  - `EnsureDiscovered` - без изменений на уровне сервиса (создаёт публикацию);
    версии заводятся владельцем явно.
- **Catalog/view API** (`internal/api/handlers_publications.go`):
  - `publicationSummary`: `recommended_version`, `orderable_versions` (список +
    их количество для «+N»), `has_order_view`/`published` по orderable+approved.
  - `/charts/{project}/{name}/view?version=X` - per-version approved view
    (в роуте уже заложен `{version}`).
- **Provisioning** (`internal/provisioning/service.go`): `resourceIdentity` и
  `applyViewDefaults` берут view **выбранной версии** заказа, не единственный
  `ActiveView`. Гард: заказать можно только `orderable AND APPROVED` версию.
  Валидация значений - против схемы выбранной версии (уже `GetSchema(version)`).

## Фронт

- **OrderPage** (`web/src/pages/OrderPage.tsx`): для нового заказа - селектор
  версии (дефолт - рекомендуемая), загрузка view+схемы под выбранную версию;
  upgrade-флоу опирается на allowlist orderable-версий вместо одной approved
  (`web/src/lib/semver.ts: upgradeTargets`).
- **CatalogPage `ChartCard`** (`web/src/pages/CatalogPage.tsx`): основной чип -
  рекомендуемая/последняя orderable-версия, рядом «+N» (число остальных
  orderable), tooltip перечисляет. См. решение в TODO.
- **ChartManagePage** (`web/src/pages/ChartManagePage.tsx`): редактирование view
  **по версиям** - выбрать версию чарта, править её view, submit; статус
  согласования на версию; тумблеры `orderable` и выбор рекомендуемой;
  per-version diff при появлении новой версии чарта.
- **AdminApprovals** (`web/src/pages/AdminSection.tsx`,
  `web/src/components/PublicationReview.tsx`): очередь и рассмотрение submission
  по конкретной версии.
- **Типы** (`web/src/api/types.ts`): зеркалирование новых полей.

## Наблюдаемость, тесты, доки

- Тесты FSM-по-версии (submit/approve/reject на разных версиях независимо),
  заказа выбранной версии, гарда orderable.
- Логи/метрики по правилам наблюдаемости там, где это значимый сигнал
  (согласование версии, изменение allowlist).
- Обновить пользовательскую доку каталога и `docs/idp-spec.md`.

## Разбивка на PR (фазы)

1. Миграция + бэкфилл + модель `PublicationVersion` + store (postgres+memory).
2. FSM-по-версии в `publications.Service` + `ActiveView(version)` + allowlist +
   recommended.
3. Catalog/view API: `publicationSummary` с версиями, `view?version=`.
4. Provisioning: identity/defaults/гард по выбранной версии.
5. Фронт заказа: селектор версии + upgrade по allowlist.
6. Фронт каталога: «+N» на карточке.
7. Конструктор view по версиям + approvals по версии.
8. Тесты/доки/наблюдаемость (по ходу каждой фазы, финальная вычитка здесь).
