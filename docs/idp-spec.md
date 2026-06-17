# Internal Developer Portal - спецификация

UI-портал для dev-команд: каталог Helm-чартов из Harbor, self-service заказ managed services через GitOps, и наблюдение за статусом деплоя через ArgoCD.

## Цели

1. **Каталог чартов** - devs видят, какие managed services доступны, изучают версии, changelog и values
2. **Self-service** - заказ инстанса сервиса через форму, которая генерирует MR в GitOps-репо
3. **Статус деплоя** - наблюдение за тем, как ArgoCD раскатывает заказанный сервис

## Стек

- **Backend:** Go 1.22+
- **Storage:** Harbor (OCI), GitLab, ArgoCD, Redis (кэш), Postgres (state)
- **Auth:** OIDC через **Keycloak**, server-side сессии в Redis
- **Frontend:** React + **React Aria** (Adobe, headless/доступные компоненты) + **Tailwind** (стайлинг, плагин `tailwindcss-react-aria-components`) + Monaco Editor (отдельный документ)
- **Деплой:** Helm-чарт в тот же кластер

> **Статус upstream'ов:** на старте Harbor, GitLab и ArgoCD **недоступны**. Архитектура строится вокруг портов (интерфейсов) + in-memory фейков, переключаемых конфигом, чтобы полный happy-path гонялся локально только с Postgres+Redis. См. раздел «Тестирование».

## Архитектура

```
┌─────────┐
│  React  │
│   UI    │
└────┬────┘
     │ JWT (OIDC, Keycloak)
     ▼
┌─────────────────────────────────────┐
│         Go backend (REST API)        │
│  ┌──────────┬──────────┬──────────┐ │
│  │ Catalog  │ Provision│  Status  │ │
│  │ service  │ service  │  service │ │
│  └────┬─────┴─────┬────┴────┬─────┘ │
└───────┼───────────┼─────────┼───────┘
        │           │         │
        ▼           ▼         ▼
   ┌─────────┐ ┌────────┐ ┌─────────┐
   │ Harbor  │ │ GitLab │ │ ArgoCD  │
   └─────────┘ │  API   │ │   API   │
               └────────┘ └─────────┘
        │           │         │
        └───────────┴─────────┘
                    │
              ┌─────┴─────┐
              ▼           ▼
         ┌────────┐  ┌─────────┐
         │ Redis  │  │Postgres │
         │ (cache)│  │ (state) │
         └────────┘  └─────────┘
```

Backend - три логических домена в одном бинаре (catalog, provisioning, status). Postgres хранит локальное состояние заказов (request → MR → ArgoCD Application). Redis - кэш иммутабельных метаданных.

## Аутентификация и авторизация

### Flow (Keycloak OIDC) - server-side сессии

1. Frontend инициирует OIDC Authorization Code flow с PKCE
2. Keycloak редиректит обратно с кодом
3. Backend обменивает код на access/ID/refresh токены, валидирует подпись через JWKS Keycloak'а
4. Backend создаёт серверную сессию в Redis (хранит access/ID/refresh токены + claims), а в браузер ставит только **session-id** в HTTP-only cookie
5. Каждый запрос - session-id в cookie → backend поднимает сессию из Redis и достаёт claims
6. **Молчаливый refresh:** если access-токен истёк, backend рефрешит его по refresh-токену из сессии и обновляет Redis. Если refresh не удался - сессия инвалидируется, 401 → редирект на логин

> Токены **не** кладутся в cookie напрямую: cookie остаётся маленьким (не зависит от размера `groups`), ревокация - простое удаление ключа из Redis. `logout` чистит сессию в Redis + cookie + Keycloak logout.

Ключи сессий в Redis: `session:{id}` (TTL = время жизни refresh-токена), значение - зашифрованный JSON с токенами и claims.

### Claims

- `sub` - user ID
- `email`, `preferred_username`, `name` - для UI и audit log
- `groups` - для RBAC

В Keycloak нужно настроить **Group Membership Mapper**, чтобы в токене были группы пользователя.

### RBAC

Approval flow не нужен (только dev). Tenant-единица - **команда/проект**, заданная группой вида `team-*` (`team-core`, `team-dbaas`, …). Суффикс группы = имя команды.

Три роли:

| Роль | Источник | Права |
|---|---|---|
| `viewer` | по умолчанию для аутентифицированного юзера | Читать каталог, видеть свои заказы и заказы своей команды |
| `member` | состоит в группе `team-*` | viewer + создавать/изменять/удалять заказы своей команды |
| `admin` | состоит в admin-группе (`RBAC_ADMIN_GROUPS`, **TBD** точное имя в KK) | member + всё видит, может управлять любым заказом, форсить sync |

Маппинг группа → команда: `team-core` → команда `core` (срезаем префикс `RBAC_TEAM_GROUP_PREFIX=team-`).

Чарты могут иметь allowlist команд в аннотации `idp.allowed-teams` (если пусто - доступны всем).

Approval flow и роль `approver` **не закладываются** - у нас только dev, staging/prod не планируются.

## Кластеры

**Сейчас:** один кластер (dev). В форме заказа выбора кластера нет, все деплои идут в `in-cluster`.

**Архитектурно заложено на будущее:** в БД у заказа есть поле `cluster`, в Application манифесте используется `destination.name`. Когда появится второй кластер - добавится dropdown в форму, и список доступных кластеров будет читаться из ArgoCD (`GET /api/v1/clusters`) с фильтрацией по правам команды.

## Источники данных

### Harbor API v2.0

База: `https://harbor.example.com/api/v2.0`

| Эндпоинт | Назначение |
|---|---|
| `GET /projects` | Список проектов |
| `GET /projects/{project}/repositories` | Чарты в проекте |
| `GET /projects/{project}/repositories/{repo}/artifacts` | Версии чарта |
| `GET /projects/{project}/repositories/{repo}/artifacts/{ref}` | Детали версии |
| `GET .../additions/values.yaml` | values.yaml |
| `GET .../additions/readme.md` | README.md |
| `GET .../additions/dependencies` | Subcharts |

Webhook от Harbor (`POST /webhooks/harbor`) на `PUSH_ARTIFACT` - инвалидирует кэш списков версий.

Аутентификация: robot account, токен в env.

### GitLab API

| Эндпоинт | Назначение |
|---|---|
| `GET /groups/{group%2Fsubgroup}` | Проверить, что подгруппа команды существует (если нет → ошибка, портал её НЕ создаёт) |
| `GET /projects/{group%2Fsubgroup%2Frepo}` | Резолв репо managed-сервиса по пути → project_id (404 → создаём) |
| `POST /projects` | Создать репо managed-сервиса в подгруппе команды (идемпотентно, если 404 выше) |
| `GET /groups/{id}/projects` | Список репо команды |
| `POST /projects/{id}/repository/branches` | Создать ветку |
| `POST /projects/{id}/repository/commits` | Commit с файлами |
| `POST /projects/{id}/merge_requests` | Создать MR |
| `GET /projects/{id}/merge_requests/{iid}` | Статус MR |

Аутентификация: **group access token** верхнеуровневой группы `managed-services` со scope `api` (а не отдельного репо - репо много и они создаются на лету).

### ArgoCD API

| Эндпоинт | Назначение |
|---|---|
| `GET /api/v1/applications?selector=...` | Список Applications с фильтром по лейблам |
| `GET /api/v1/applications/{name}` | Детали Application |
| `GET /api/v1/stream/applications` | SSE-стрим событий (если доступен) |
| `POST /api/v1/applications/{name}/sync` | Принудительная синхронизация (admin) |
| `GET /api/v1/clusters` | Список зарегистрированных кластеров (для будущего multi-cluster) |

Аутентификация: project token ArgoCD.

### CHANGELOG.md из Harbor OCI

Не через Harbor additions API, а напрямую:

1. Backend пуллит `.tgz` через OCI Distribution API (`GET /v2/{repo}/blobs/{digest}`)
2. Распаковывает в памяти (`archive/tar` + `compress/gzip`)
3. Читает `{chart}/CHANGELOG.md`
4. Парсит секции regex'ом по версиям
5. Кэширует распарсенный результат по digest на 30 дней

Конвенция формата (Keep a Changelog):

```markdown
## [15.4.2] - 2026-05-20
### Added
- New ingress annotations support
### Fixed
- Memory leak in sidecar
### Security
- Bumped base image (CVE-2024-XXXX)

## [15.4.1] - 2026-05-15
### Fixed
- ...
```

Если CHANGELOG.md отсутствует - UI показывает плейсхолдер "No changelog available". Политика: команды чартов обязаны его поддерживать.

## Версии

Никакого вычисления «latest»/«stable» и semver-фильтрации не делаем. По умолчанию в форме предвыбран **последний тег** (как его отдаёт Harbor - по времени пуша артефакта). Список версий - все теги как есть, без бейджей. Пользователь при желании выбирает другую версию из списка.

> Если позже понадобится семантика «latest по semver» или бейджи - добавим (см. `catalog/semver.go` остаётся, но на MVP не используется для бейджей).

## Self-service: заказ сервиса

### Концепция

Заказ - это запрос на создание (или изменение) Helm Application в GitOps-репо. Portal генерирует MR с values.yaml + ArgoCD Application манифестом. После merge ArgoCD деплоит.

**Источник истины для values - Git.** Поле `values_yaml` в Postgres - это удобный кэш для отрисовки формы и истории, но канонично то, что лежит в GitOps-репо. При расхождении (кто-то правит Git напрямую) Git выигрывает.

### Структура GitOps-репо

Это **не один репозиторий**, а **группа репозиториев** в GitLab. Разделение нужно для изоляции доступа: команда видит и правит только своё, доступ контролируется GitLab-правами на уровне подгрупп/репо.

Иерархия:

```
managed-services/              ← top-level GitLab group (GITLAB_GITOPS_GROUP)
  team-core/                   ← подгруппа команды - ЗАВОДИТСЯ ВРУЧНУЮ (портал не создаёт)
    gateway/                   ← репо = managed service (chart) - портал создаёт 1 раз, если нет
      payments-gateway/        ← папка = заказанный инстанс (service_name)
        application.yaml       ← ArgoCD Application манифест
        values.yaml
      public-gateway/          ← второй инстанс того же сервиса той же команды
        application.yaml
        values.yaml
    postgres/                  ← другой managed service
      payments-db/
        application.yaml
        values.yaml
  team-dbaas/                  ← другая команда, изолирована правами GitLab
    ...
```

- **Путь к манифестам:** `{GITLAB_GITOPS_GROUP}/{team-subgroup}/{chart}/{service_name}/`.
  - `team-subgroup` - по шаблону `GITLAB_TEAM_SUBGROUP_TEMPLATE` (дефолт `team-{{.Team}}`, совпадает с Keycloak-группой).
  - Репо называется по managed-сервису (имя чарта), внутри - папка на каждый заказанный инстанс (`service_name`), т.к. команда может заказать несколько инстансов одного сервиса.
- **Создание:**
  - **Подгруппу команды портал НЕ создаёт** - она должна быть заведена заранее. Если её нет → заказ падает с понятной ошибкой (`502/конфиг`), а не молча.
  - **Репо managed-сервиса портал создаёт идемпотентно:** проверяет существование по пути, есть - использует, нет - `POST /projects` в подгруппе команды.
- **Изоляция:** портал ходит **group access token**'ом с правами на всю `managed-services`; права отдельных команд на свои подгруппы настраиваются в GitLab отдельно (вне портала).
- **MR создаётся в репо конкретного сервиса**, меняет файлы в папке инстанса. Поэтому `mr_iid` сам по себе не идентифицирует MR - нужен ещё `gitlab_project_id` репо (см. таблицу `request_mrs`).

Модуль `provisioning/gitops.go` инкапсулирует резолв пути, идемпотентное создание репо и генерацию файлов. Остальная архитектура от конвенции не зависит.

### Формы заказа (динамические по чарту)

**Контракт = `values.schema.json` (JSON Schema)** - нативный стандарт Helm. Helm сам валидирует против него values при install/upgrade, авторы чартов уже его поддерживают. Это источник истины для валидации; **другие форматы не вводим** (OpenAPI здесь не альтернатива - его Schema Object это и есть JSON Schema, только в обёртке про HTTP-API).

JSON Schema - язык валидации, не язык UI. Поэтому presentation отделяем:

- **UI-слой (опционально)** - порядок полей, виджет, help-текст, плейсхолдеры, группировка. Поддерживаем `uiSchema` (отдельный объект, как в react-jsonschema-form) и/или `x-*` vendor-расширения внутри схемы. Чарт может поставлять компаньон-файл (напр. `values.ui.json`); нет - рендерим по дефолту из схемы.
- **Курируемое подмножество, а не всё дерево.** Большие чарты (сотни полей) в виде сплошной формы нечитаемы. Рендерим то, что юзер реально задаёт; остальное - дефолты чарта. Какие поля показывать - из `required` + UI-слоя (явный список важных полей).
- **Рендерер - тонкий собственный на React Aria.** Обходим JSON Schema (object/string/number/bool/enum/array - подмножество, которым и являются Helm-values) и эмитим компоненты React Aria → полный контроль + нативная a11y.
- **Raw-YAML (Monaco) - штатная вторая панель**, не запасной вариант: для полей вне курируемой формы и для power-юзеров. Если у чарта нет `values.schema.json` - сразу только raw-YAML.

**Валидация на бэке обязательна:** сабмит всегда валидируется против `values.schema.json` сервером (`santhosh-tekuri/jsonschema`), независимо от того, что прислал клиент.

Дополнительно - структурированные поля заказа (не из values):
- `team` - выбор из доступных пользователю команд
- `service_name` - k8s-валидное имя
- `chart_version` - выбор из доступных версий (по умолчанию предвыбран последний тег)

### Жизненный цикл заказа

Без approval flow - упрощённая FSM:

```
DRAFT ──▶ MR_CREATED ──▶ MR_MERGED ──▶ DEPLOYING ──▶ HEALTHY
                │             │            │
                ▼             ▼            ▼
            MR_CLOSED      ARGO_MISSING  DEGRADED
              (cancel)     (timeout)     (failed)
```

Дополнительно для удалений:

```
HEALTHY ──▶ DELETE_REQUESTED ──▶ DELETE_MR_MERGED ──▶ DELETED
```

Статусы хранятся в Postgres, обновляются:
- `DRAFT → MR_CREATED` - при submit формы
- `MR_CREATED → MR_MERGED` - через GitLab webhook или polling
- `MR_MERGED → DEPLOYING` - когда ArgoCD Application появляется и Status=Progressing
- `DEPLOYING → HEALTHY/DEGRADED` - через ArgoCD webhook или polling

### Кто может изменять/удалять

Любой member команды, к которой принадлежит заказ, может изменять и удалять. Admin может управлять любым заказом.

**Конкурентность:**
- На один заказ допускается **только один открытый MR** за раз. Пока есть MR в статусе `opened`, PATCH/DELETE отклоняются (`409 conflict`) - иначе получим конфликтующие MR на один сервис.
- На строке `requests` - оптимистичная блокировка (колонка `version`): апдейт проверяет, что версия не изменилась, иначе `409`. Защищает от потерянных обновлений при одновременном редактировании.

Audit log в Postgres фиксирует, кто инициировал каждое действие.

### Удаление (soft delete)

Удаление - **soft**:
- В БД ставим флаг `deleted_at` (timestamp) и финальный статус `DELETED`
- Запись не удаляется, остаётся в истории
- При создании нового заказа с тем же `service_name` (для той же команды и того же чарта) - это **новый заказ с новым ID**, старый продолжает существовать в истории под пометкой "deleted"
- UI показывает удалённые заказы в отдельной вкладке "History" или с тогглом "Show deleted"

Уникальность активного сервиса гарантируется индексом (см. раздел Persistence):
```sql
CREATE UNIQUE INDEX uniq_active_service
  ON requests (team, chart_name, service_name, cluster)
  WHERE deleted_at IS NULL;
```

Сам процесс удаления:
1. Юзер жмёт Delete → создаётся MR на удаление **всей папки инстанса** `{chart}/{service_name}/` (все файлы в ней - `application.yaml`, `values.yaml` и что там ещё есть). Технически GitLab Commit API удаляет файлы по одному (`action: delete` на каждый путь), поэтому сначала перечисляем содержимое папки, затем формируем коммит с удалением всех файлов. Сам репо чарта остаётся (в нём могут быть другие инстансы).
2. После merge ArgoCD удаляет ресурсы (cascade через finalizers)
3. Когда ArgoCD Application пропадает из API - заказ помечается `deleted_at = now()`, статус `DELETED`

### Идентификация ArgoCD Application

**TBD** - конкретный шаблон решите позже. Заложено поле `argocd_app_name` в БД, формат именования - конфигурируемый шаблон (env-переменная). Дефолт: `{team}-{service_name}`.

**Правило:** имя вычисляется **один раз при создании заказа** и сохраняется в `argocd_app_name`; дальше матчинг ArgoCD Application идёт по сохранённому значению, а не пересчитывается из шаблона. Так смена `ARGOCD_APP_NAME_TEMPLATE` не ломает уже существующие заказы.

## REST API

База: `/api/v1`. Все эндпоинты требуют OIDC JWT, кроме `/health`, `/ready`, `/metrics`, `/auth/*`.

### Auth

- `GET /auth/login` - редирект на Keycloak
- `GET /auth/callback` - OIDC callback, ставит cookie
- `POST /auth/logout` - чистит cookie + редирект на Keycloak logout
- `GET /auth/me` - текущий пользователь, его роли и команды

### Каталог

- `GET /charts` - каталог
- `GET /charts/{project}/{name}` - детали + версии
- `GET /charts/{project}/{name}/{version}` - детали версии
- `GET /charts/{project}/{name}/{version}/values` - values.yaml
- `GET /charts/{project}/{name}/{version}/readme` - README.md
- `GET /charts/{project}/{name}/{version}/changelog` - changelog текущей версии
- `GET /charts/{project}/{name}/changelog/aggregated?limit=20` - changelog по всем версиям
- `GET /charts/{project}/{name}/{version}/schema` - values.schema.json для рендера формы
- `GET /charts/{project}/{name}/icon` - иконка

### Заказы (provisioning)

- `GET /requests` - мои заказы / заказы моей команды. Query: `?team=`, `?status=`, `?chart=`, `?include_deleted=false`
- `GET /requests/{id}` - детали (state, MR, ArgoCD Application, audit log)
- `POST /requests` - создать:
  ```json
  {
    "chart": "platform/postgres",
    "version": "15.4.2",
    "team": "payments",
    "service_name": "payments-db",
    "values": { /* объект, валидируется против JSON Schema */ }
  }
  ```
- `PATCH /requests/{id}` - изменить (member команды) - создаёт новый MR
- `DELETE /requests/{id}` - soft-delete (member команды) - создаёт MR на удаление файлов
- `POST /requests/{id}/sync` - форсированный ArgoCD sync (admin)
- `GET /requests/{id}/events` - SSE-стрим обновлений статуса

### Статус деплоя

- `GET /applications` - все ArgoCD Applications, видимые пользователю
- `GET /applications/{name}` - детали (sync status, health, ресурсы, история деплоев)
- `GET /applications/{name}/events` - SSE-стрим

### Health

- `GET /health` - liveness
- `GET /ready` - readiness (Postgres, Redis)
- `GET /metrics` - Prometheus

### Webhooks (внешние)

- `POST /webhooks/harbor` - HMAC signature
- `POST /webhooks/gitlab` - token-based, на события merge/close MR
- `POST /webhooks/argocd` - **если доступны в инсталляции; иначе polling**

## Стратегия обновления статуса от ArgoCD (TBD)

Уточнить, есть ли webhook'и в текущей инсталляции ArgoCD (`notifications-controller` или `applicationset-controller` с webhook'ами).

**Если есть webhook'и:**
- ArgoCD пушит события на `POST /webhooks/argocd`
- Backend обновляет статус заказа в БД
- SSE-стрим клиентам - мгновенно

**Если webhook'ов нет - polling:**
- Background-воркер каждые **15 секунд** опрашивает `GET /api/v1/applications?selector=managed-by=portal`
- Diff'ит с состоянием в БД, обновляет статусы
- Дополнительно - попытка использовать `GET /api/v1/stream/applications` (SSE от самого ArgoCD), если доступен

Архитектура заложена так, что переключение режима - это конфиг (`STATUS_UPDATE_MODE=webhook|polling|stream`), код одинаковый. Дефолт MVP - `polling` (самое безопасное предположение).

> **MVP - одна реплика.** Поллер и SSE работают **в процессе** (in-process канал событий), без Redis Pub/Sub и без leader election. Это сознательное упрощение для одной реплики. **Техдолг перед горизонтальным масштабированием:** добавить Redis Pub/Sub для fan-out SSE между репликами + leader election (advisory lock в Postgres) для поллера, иначе реплики будут дублировать поллинг и ловить гонки на апдейтах статуса.

## Persistence (Postgres)

```sql
CREATE TABLE requests (
  id              UUID PRIMARY KEY,
  created_by      TEXT NOT NULL,        -- sub из JWT
  created_by_name TEXT NOT NULL,        -- для отображения
  team            TEXT NOT NULL,
  chart_project   TEXT NOT NULL,
  chart_name      TEXT NOT NULL,
  chart_version   TEXT NOT NULL,
  service_name    TEXT NOT NULL,
  cluster         TEXT NOT NULL DEFAULT 'in-cluster',  -- задел на multi-cluster
  values_yaml     TEXT NOT NULL,
  status          TEXT NOT NULL,        -- DRAFT, MR_CREATED, DEPLOYING, HEALTHY, ...
  argocd_app_name TEXT,                  -- вычисляется один раз при создании
  version         INT NOT NULL DEFAULT 1,-- оптимистичная блокировка
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ                          -- soft delete
);

-- Уникальность только среди активных.
-- Ключ совпадает с путём в GitOps: team-subgroup / chart / service_name (одна папка = один активный инстанс).
CREATE UNIQUE INDEX uniq_active_service
  ON requests (team, chart_name, service_name, cluster)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_requests_team ON requests(team);
CREATE INDEX idx_requests_status ON requests(status);
CREATE INDEX idx_requests_created_by ON requests(created_by);

CREATE TABLE request_mrs (
  id                UUID PRIMARY KEY,
  request_id        UUID NOT NULL REFERENCES requests(id),
  gitlab_project_id INT NOT NULL,             -- репо сервиса (mr_iid уникален только в пределах репо)
  mr_iid            INT NOT NULL,
  mr_url            TEXT NOT NULL,
  mr_status         TEXT NOT NULL,            -- opened, merged, closed
  action            TEXT NOT NULL,            -- create, update, delete
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE request_events (
  id          BIGSERIAL PRIMARY KEY,
  request_id  UUID NOT NULL REFERENCES requests(id),
  actor       TEXT,                     -- кто инициировал (для audit)
  event_type  TEXT NOT NULL,            -- created, updated, deleted, status_changed, sync_forced
  from_status TEXT,
  to_status   TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_request_events_request ON request_events(request_id);
CREATE INDEX idx_request_events_created ON request_events(created_at);
```

Миграции - `golang-migrate`.

## Кэширование (Redis)

| Что | TTL | Ключ |
|---|---|---|
| Каталог чартов | 5 минут | `catalog:{project}` |
| Версии чарта | 2 минуты | `versions:{project}:{name}` |
| Chart.yaml | 30 дней | `chart-yaml:{digest}` |
| values.yaml | 30 дней | `values:{digest}` |
| README.md | 30 дней | `readme:{digest}` |
| values.schema.json | 30 дней | `schema:{digest}` |
| CHANGELOG parsed | 30 дней | `changelog:{digest}` |
| ArgoCD Application | 15 секунд | `argo-app:{name}` |
| JWKS Keycloak | 1 час | `jwks:keycloak` |

Помимо кэша, Redis хранит **серверные сессии** (не кэш, не истекает по тем же правилам):

| Что | TTL | Ключ |
|---|---|---|
| Сессия (токены + claims, зашифровано) | = TTL refresh-токена | `session:{id}` |

## Структура Go-проекта

```
cmd/
  portal/
    main.go
internal/
  config/
  auth/
    oidc.go                  # Keycloak OIDC flow
    middleware.go            # JWT validation, RBAC checks
    rbac.go                  # маппинг групп → роли/команды
  harbor/
    client.go
    oci.go                   # OCI pull для tgz
    types.go
  gitlab/
    client.go
    types.go
  argocd/
    client.go
    watcher.go               # polling/SSE-watch для статусов
    types.go
  catalog/
    service.go
    semver.go
    schema.go
  changelog/
    parser.go
  provisioning/
    service.go               # бизнес-логика заказов
    state_machine.go
    gitops.go                # генерация манифестов (зависит от структуры репо)
    templates/               # шаблоны Application CR
  status/
    service.go               # маппинг ArgoCD → доменный статус
    poller.go                # background polling loop
  cache/
    redis.go
  store/
    postgres.go
    migrations/
  api/
    router.go
    handlers_catalog.go
    handlers_requests.go
    handlers_apps.go
    middleware.go
    sse.go
  webhooks/
    harbor.go
    gitlab.go
    argocd.go
  observability/
    logger.go
    metrics.go
    tracing.go
pkg/
  models/
deployments/
  helm/
Dockerfile
Makefile
go.mod
```

## Ключевые библиотеки Go

- HTTP router: `github.com/go-chi/chi/v5`
- OIDC: `github.com/coreos/go-oidc/v3` + `golang.org/x/oauth2`
- JWT: `github.com/golang-jwt/jwt/v5`
- OCI: `oras.land/oras-go/v2`
- YAML: `gopkg.in/yaml.v3`
- JSON Schema: `github.com/santhosh-tekuri/jsonschema/v5`
- Semver: `github.com/Masterminds/semver/v3`
- Markdown: `github.com/yuin/goldmark`
- Postgres: `github.com/jackc/pgx/v5`
- Migrations: `github.com/golang-migrate/migrate/v4`
- Redis: `github.com/redis/go-redis/v9`
- Logger: `log/slog` (stdlib)
- Metrics: `github.com/prometheus/client_golang`
- Config: `github.com/caarlos0/env/v11`
- Testing: stdlib + `github.com/stretchr/testify` + `github.com/testcontainers/testcontainers-go`

## Конфигурация (env)

```
# Server
HTTP_PORT=8080
PUBLIC_URL=https://portal.example.com

# OIDC (Keycloak)
OIDC_ISSUER=https://keycloak.example.com/realms/internal
OIDC_CLIENT_ID=portal
OIDC_CLIENT_SECRET=...
OIDC_REDIRECT_URL=https://portal.example.com/api/v1/auth/callback
OIDC_SCOPES=openid,profile,email,groups
SESSION_SECRET=...                 # ключ шифрования серверной сессии в Redis
SESSION_COOKIE_NAME=idp_session

# RBAC
RBAC_ADMIN_GROUPS=...              # TBD: точное имя admin-группы в Keycloak
RBAC_TEAM_GROUP_PREFIX=team-

# Harbor
HARBOR_URL=https://harbor.example.com
HARBOR_ROBOT_USER=robot$portal
HARBOR_ROBOT_TOKEN=...
HARBOR_PROJECTS=platform,managed-services
HARBOR_WEBHOOK_SECRET=...

# GitLab
GITLAB_URL=https://gitlab.example.com
GITLAB_TOKEN=...                                   # group access token группы managed-services, scope api
GITLAB_GITOPS_GROUP=managed-services               # top-level группа (путь или id)
GITLAB_TEAM_SUBGROUP_TEMPLATE=team-{{.Team}}       # подгруппа команды = Keycloak-группа
GITLAB_DEFAULT_BRANCH=main
GITLAB_WEBHOOK_TOKEN=...

# ArgoCD
ARGOCD_URL=https://argocd.example.com
ARGOCD_TOKEN=...
ARGOCD_PROJECT=portal-managed
ARGOCD_DEFAULT_CLUSTER=in-cluster
ARGOCD_APP_NAME_TEMPLATE={{.Team}}-{{.ServiceName}}    # TBD конкретный формат
STATUS_UPDATE_MODE=polling                              # polling|webhook|stream
STATUS_POLL_INTERVAL=15s
ARGOCD_WEBHOOK_SECRET=...

# Postgres
DATABASE_URL=postgres://...
DATABASE_MAX_CONNS=20

# Redis
REDIS_URL=redis://redis:6379/0

# Observability
LOG_LEVEL=info
LOG_FORMAT=json
METRICS_ENABLED=true
TRACING_ENABLED=false
```

## Observability

**Логи** - JSON через `slog`: `request_id`, `user`, `team`, `action`.

**Метрики:**
- `http_requests_total{method,path,status}` / `http_request_duration_seconds`
- `harbor_requests_total{endpoint,status}` / latency
- `gitlab_requests_total{endpoint,status}` / latency
- `argocd_requests_total{endpoint,status}` / latency
- `cache_hits_total{key_type}` / `cache_misses_total{key_type}`
- `requests_total{status,team,chart}` - заказы по статусам
- `request_state_transitions_total{from,to}`
- `request_duration_seconds{from_status,to_status}` - сколько висел в статусе
- `oci_pulls_total{status}` / `oci_pull_duration_seconds`
- `status_poll_total{result}` - успехи/ошибки polling-цикла

**Tracing** - OTel, опционально.

## Ошибки

| Ситуация | HTTP | Код |
|---|---|---|
| Не авторизован | 401 | `unauthorized` |
| Нет прав | 403 | `forbidden` |
| Не найдено | 404 | `not_found` |
| Валидация values против schema | 422 | `validation_failed` |
| Сервис с таким именем уже существует у команды | 409 | `conflict` |
| Harbor/GitLab/ArgoCD недоступен | 502 | `upstream_unavailable` |

## Безопасность

- TLS на всех upstream'ах, валидация cert
- Секреты только из env, никогда не логировать
- HMAC-валидация webhook'ов (Harbor, GitLab, ArgoCD)
- CSRF-protection через double-submit cookie
- Cookie: HttpOnly, Secure, SameSite=Lax
- Audit log в `request_events` - кто, что, когда
- values.yaml может содержать дефолтные креды - UI предупреждает; реальные секреты должны быть через ExternalSecret/SealedSecret

## Тестирование

На старте Harbor, GitLab и ArgoCD **недоступны**, поэтому архитектура строится вокруг **портов и фейков**.

### Порты + фейки

Каждый домен зависит от интерфейса, а не от конкретного клиента: `HarborPort`, `GitLabPort`, `ArgoCDPort`. Две реализации, переключаемые конфигом (`HARBOR_MODE=fake|real` и т.п.):

- **real** - HTTP-клиенты (пишем по докам API, против живых систем пока не тестируем).
- **fake** - in-memory симуляторы:
  - **Fake Harbor** - отдаёт заготовленные чарты с версиями, `values.yaml`, `README.md`, `values.schema.json`, `CHANGELOG.md` (фикстуры в репо).
  - **Fake GitLab** - моделирует группы/подгруппы/репо в памяти (резолв и создание репо сервиса), «принимает» ветку/коммит/MR, умеет авто-мержить (или мерж по триггеру в тесте). Без него заказ не сдвинется из `MR_CREATED`.
  - **Fake ArgoCD** - заводит Application, по таймеру/триггеру переводит `Progressing → Healthy` (и опц. `Degraded`), умеет удалять.

Фейки дают **dev/demo-режим**: весь портал поднимается локально (`docker-compose`: Postgres + Redis + фейки), фронт работает против настоящего API, полный happy-path заказа гоняется без реальных upstream'ов.

### Слои тестов

- **Unit:** semver, парсер CHANGELOG, JSON Schema валидация, FSM заказов, RBAC-маппинг (группы `team-*` → роли/команды). Чистые функции, без I/O.
- **Integration:** API через `httptest` + фейковые порты. Полный жизненный цикл: `POST → MR_CREATED → (fake merge) → MR_MERGED → (fake argo) → DEPLOYING → HEALTHY`, затем `DELETE → … → DELETED`. Покрываем RBAC (свой/чужой member, admin), 409 на дубль и на второй открытый MR, 422 на невалидные values.
- **E2E:** testcontainers (реальные Postgres + Redis) + фейки, поднятые как `httptest.Server` (заодно тестируем реальный HTTP-клиентский код против предсказуемых ответов).
- **Contract-тесты (задел):** фикстуры реальных JSON-ответов (сейчас по докам, позже - записанные с живых систем). Один набор контракт-тестов гоняем против фейка и (позже) реального клиента → гарантия паритета.

Цель покрытия: 70%+ на `internal/`.

### Чего пока не тестируем честно (техдолг до появления систем)

- Реальные форматы/подписи webhook'ов Harbor, GitLab, ArgoCD.
- Нюансы аутентификации робот-аккаунта в OCI registry при pull `.tgz`.
- Доступность ArgoCD webhook/SSE - на старте идём через `polling`, фейк эмулирует.

## Деплой

Helm-чарт в `deployments/helm/`:
- Deployment (**MVP - 1 реплика**; in-process поллер/SSE не переживают масштабирование, см. техдолг в разделе про статусы)
- Service ClusterIP
- Ingress
- ServiceMonitor
- **HPA - выключен на MVP** (включается вместе с Redis Pub/Sub + leader election)
- NetworkPolicy: egress в Harbor/GitLab/ArgoCD/Keycloak/Postgres/Redis; ingress из общего ingress controller'а
- Postgres - отдельный chart (dogfooding: portal-managed postgres)

## Roadmap

**MVP (эта спека):**
- Каталог + версии + values + changelog из CHANGELOG.md
- Keycloak OIDC + RBAC (viewer / member / admin)
- Self-service: форма → MR → ArgoCD (только dev, один кластер)
- Статус деплоя
- Soft delete с историей

**v2 (потенциально, по необходимости):**
- **Горизонтальное масштабирование:** Redis Pub/Sub для SSE fan-out + leader election (advisory lock) для поллера → 2+ реплики + HPA
- Diff между версиями values
- Поиск по чартам
- Граф зависимостей
- Логи подов из UI
- Уведомления (Slack/Mattermost)

> **Только dev-окружение.** Staging/prod не планируются, поэтому **approval flow / роль `approver`** и **multi-cluster** в roadmap **не закладываются**. Дешёвый архитектурный задел (поле `cluster`, `destination.name`) оставляем как есть - он ничего не стоит, - но фичи под него не делаем.

**v3:**
- Quota на команду (лимит числа сервисов / ресурсов - не биллинг; всё бесплатно)
- Scorecards (HPA, PDB, resource limits и т.д.)
- Bundle-templates (заказать "стек payments" одной формой)

## Открытые вопросы (продолжают висеть)

1. **Admin-группа в Keycloak** - TBD, точное имя/путь группы для роли `admin` (`RBAC_ADMIN_GROUPS`).
2. **Идентификация ArgoCD Application** - TBD, конкретный шаблон имени. Сейчас дефолт `{team}-{service_name}`, фиксируется при создании заказа.
3. **ArgoCD webhook'и** - нужно уточнить, есть ли в инсталляции. До выяснения - режим `polling` каждые 15 секунд.

**Решено** (GitOps-конвенция): группа репозиториев `managed-services/team-{team}/{chart}/{service_name}/`; подгруппа команды заводится вручную, репо сервиса портал создаёт идемпотентно; `application.yaml` + `values.yaml` лежат в папке инстанса внутри репо.
