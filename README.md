# Internal Developer Portal

Go backend + React SPA: каталог Helm-чартов из **Harbor**, self-service заказ
managed-services через **GitOps-MR** в GitLab, наблюдение за деплоем через
**Argo CD**.

Полная спецификация - [`docs/idp-spec.md`](./docs/idp-spec.md), конвенция чартов -
[`docs/chart-convention.md`](./docs/chart-convention.md).

## Возможности

- Каталог чартов из Harbor (живой листинг, новые версии видны сразу),
  README / CHANGELOG / values / schema из артефакта.
- Заказ сервиса -> коммит `application.yaml` + `values.yaml` в GitLab -> MR ->
  Argo CD деплоит чарт из Harbor. Статус заказа (`DRAFT -> ... -> HEALTHY`) через
  поллер + live-обновления по SSE.
- Обратная синхронизация с Git: drift-детект (правки мимо портала), pull
  («Подтянуть из Git»), import осиротевших манифестов.
- Страница «Статус»: здоровье интеграций (Keycloak / Harbor / GitLab / Argo CD) и
  хранилищ.

## Архитектура запуска

В разработке **инфраструктура крутится в Docker**, а **portal и web запускаются из
исходников** (live-reload) - так правится и бэкенд, и фронт без пересборки
контейнеров.

| Слой | Где | Команда |
|---|---|---|
| Postgres + Redis + Keycloak | Docker (compose) | `make infra` |
| Backend (portal) | хост, `go run` | `make run` / `make run-oidc` |
| Frontend (SPA) | хост, Vite | `make web` |

Upstream'ы (Harbor / GitLab / Argo CD) по умолчанию **fake** (in-memory) - happy-path
заказа гоняется без какой-либо инфраструктуры. Реальный стек - опциональный e2e-стенд
(см. ниже).

## Требования

- Docker + docker compose (Docker Desktop или engine + plugin)
- Go 1.26+
- [bun](https://bun.sh) 1.x (фронтенд; npm не используется)
- `make`, `git`

## Быстрый старт (dev-loop)

Три команды в трёх терминалах:

```sh
make infra      # Postgres + Redis + Keycloak в Docker (detached)
make run        # backend на :8080 - fakes + memory + dev-auth (без Keycloak)
make web        # Vite на :5173 (live-reload), проксирует /api -> :8080
```

Открыть **http://localhost:5173**. В режиме `make run` фронт-прокси подставляет
заголовки `X-Dev-*` (см. `web/.env.development`), и SPA открывается как member
команды `core` - Keycloak не нужен.

Остановить инфраструктуру: `make down` (сносит контейнеры и volume'ы).

## OIDC через Keycloak

Чтобы пройти реальный логин, замени `make run` на `make run-oidc` (Keycloak уже
поднят через `make infra`):

```sh
make infra
make run-oidc   # backend на :8080 - OIDC + Postgres + Redis (сессии/заказы переживают рестарт)
make web
```

Открыть http://localhost:5173 -> «Войти через Keycloak». Браузер и портал делят один
issuer `http://localhost:8081/realms/internal`, поэтому портал и запускается на хосте.

Тестовые пользователи (realm `internal`, импортируется в Keycloak автоматически):

| Пользователь | Пароль | Группы | Роль |
|---|---|---|---|
| `alice` | `alice` | `team-core`, `team-dbaas` | member (команды `core`, `dbaas`) |
| `padmin` | `padmin` | `platform-admins`, `team-core`, `team-dbaas` | admin |

Keycloak admin-консоль: http://localhost:8081 (`admin` / `admin`).

> Доступ с другой машины (LAN): добавь `http://<твой-host>:5173/` и
> `http://<твой-host>:5173/api/v1/auth/callback` в клиент `portal`
> (Valid redirect URIs / Web origins / Valid post logout redirect URIs) и запусти
> бэкенд с соответствующими `OIDC_*` (на Windows удобно
> `deployments/scripts/run-oidc.ps1 -BindHost <ip>`).

## Dev-режим аутентификации

`AUTH_MODE=dev` подставляет пользователя без Keycloak; переопределяется заголовками
`X-Dev-Sub`, `X-Dev-Name`, `X-Dev-Teams` (csv), `X-Dev-Role` (`viewer|member|admin`).
Vite-прокси шлёт их в dev-режиме на основе `web/.env.development`.

## Полный контейнерный стек (без исходников)

Если нужен запуск целиком в Docker (portal + web в контейнерах, fake-upstream'ы,
dev-auth) - например для демо без тулчейна:

```sh
make up         # сборка и запуск всего стека
make down       # остановить + снести volume'ы
```

| URL | Что |
|---|---|
| http://localhost:8088 | Frontend (SPA), nginx, проксирует `/api` |
| http://localhost:8080 | Backend (`/health`, `/ready`, `/metrics`) |
| http://localhost:8081 | Keycloak (`admin` / `admin`) |

## Опционально: реальный e2e-стенд (KinD)

Полный стек с реальными GitLab CE + Harbor + Argo CD поднимается отдельным
KinD-стендом. Он тяжёлый (GitLab ~4 ГБ ОЗУ) и **только под Windows/PowerShell**.
Инструкция и команды (`make stand-up`, `make up-upstreams`, `make gitlab-seed`) -
в [`deployments/kind/README.md`](./deployments/kind/README.md).

Чарты в репозитории не вендорятся - их источник Harbor. Засеять Harbor стенда из
внешнего каталога чартов: `make stand-charts` со `STAND_CHARTS_DIR=<path>`.

## Конфигурация

Все переменные с описанием - в [`.env.example`](./.env.example) (он же источник
правды наравне с `internal/config/config.go`; синхронность проверяет тест
`TestEnvExampleInSync`). Ключевое:

| Переменная | Значения | Назначение |
|---|---|---|
| `HARBOR_MODE` / `GITLAB_MODE` / `ARGOCD_MODE` | `real` (деф.) \| `fake` | upstream'ы; `real` требует URL/токен (иначе старт падает) |
| `STORE` / `CACHE` | `memory` (деф.) \| `postgres` / `redis` | состояние / кэш + сессии |
| `AUTH_MODE` | `oidc` \| `dev` | аутентификация |
| `RBAC_TEAM_GROUP_PREFIX` / `RBAC_TEAM_GROUP_REGEX` | строка | маппинг групп IdP -> команды |
| `CHART_REGISTRY` | строка | OCI-база chart-source в `application.yaml` (Harbor) |
| `GITLAB_AUTO_MERGE` | `false` \| `true` | поллер сам мёржит MR (локалка / демо) |
| `DRIFT_DETECTION_ENABLED` / `IMPORT_DISCOVERY_ENABLED` | bool | обратная синхронизация с Git |

## Фронтенд

SPA на **React + React Aria + Tailwind + Monaco** (Vite, TS) в [`web/`](./web):
каталог, динамическая форма по `values.schema.json` (+ raw-YAML в Monaco), заказы
с live-статусом по SSE, страница статуса. Dev-сервер: `make web` (или
`cd web && bun install && bun run dev`). Пакетный менеджер - **bun** (не npm).

## Структура

```
cmd/portal/          - entrypoint
internal/
  config/            - env-конфиг (источник правды для .env.example)
  auth/              - OIDC + сессии (Redis) + RBAC + dev-режим
  harbor/ gitlab/ argocd/ - порты + fake (тесты) + real HTTP/OCI-клиенты
  store/ cache/      - Postgres/Redis (+ миграции) и memory
  catalog/ changelog/- каталог чартов + парсер CHANGELOG
  provisioning/      - заказы: FSM, gitops, реконсиляция, drift/import/pull
  status/ events/    - read-only Argo + поллер; in-process pub/sub для SSE
  api/               - chi-роутер, хендлеры, SSE, /status
pkg/models/          - доменные типы
web/                 - фронтенд
deployments/
  docker-compose.yml            - инфра (infra) + полный контейнерный стек (up)
  docker-compose.upstreams.yml  - оверлей с реальным GitLab CE (для KinD-стенда)
  keycloak/ gitlab/             - realm-импорт и сид GitLab
  kind/                         - реальный e2e-стенд (KinD + Argo CD + Harbor), Windows
  scripts/                      - хост-хелперы (run-oidc, reset-state, seed-import)
internal/harbor/charts/ - минимальная тест-фикстура чарта (НЕ деплоится)
```

## Заметки по архитектуре

- **Источник чартов - Harbor**; репозиторий chart-agnostic (реальные чарты живут
  отдельно и публикуются в Harbor своим пайплайном).
- **Git - источник истины** для values; `values_yaml` в БД - снимок для UI
  (drift/pull синхронизируют его с Git).
- **Одна реплика**: поллер/SSE in-process (техдолг до масштабирования - `TODO.md`).
- **Один открытый MR на заказ** + оптимистичная блокировка (`version`).
