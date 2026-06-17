# TODO

Статус: бэкенд на портах (Harbor/GitLab/ArgoCD - реальные клиенты + fake для
тестов), Postgres/Redis, OIDC (Keycloak), фронт (React + React Aria + Tailwind +
Monaco). E2e проверен: заказ проходит цикл до HEALTHY на реальном KinD-стенде.
Полная спека - `docs/idp-spec.md`, конвенция чартов - `docs/chart-convention.md`.

## Сделано (с момента MVP)

- [x] Реальные клиенты **Harbor** (API v2.0 + OCI pull `.tgz`), **GitLab**
  (группы/репо/ветки/коммиты/MR), **ArgoCD** (чтение health/sync Application).
  `*_MODE=real` - теперь **дефолт** (fake - только тесты + явный opt-in).
- [x] Источник чартов - Harbor; репозиторий chart-agnostic (см.
  `docs/chart-convention.md`). В репо только тест-фикстура в `internal/harbor/charts`.
- [x] Обратная синхронизация с Git: drift-детект (флаг + баннер), «Подтянуть из
  Git» (pull), импорт «осиротевших» манифестов (только валидные/идентичные нашим).
- [x] Страница «Статус» - здоровье интеграций (Keycloak/Harbor/GitLab/ArgoCD) +
  хранилищ, ссылки на UI.
- [x] RBAC: маппинг групп гибкий (префикс по любому сегменту пути или regex,
  `RBAC_TEAM_GROUP_REGEX`) - терпим к внешнему Keycloak с вложенными группами.

## 1. Деплой самого портала (Helm-чарт) - следующий большой шаг

Портал - тоже managed service в своей парадигме, но катать его пока нечем (есть
только локальный `deployments/docker-compose.yml`).

- [ ] Helm-чарт портала (`charts/`-стиль, но в своём репо/пайплайне, не вендорить
  сюда): `Deployment` + `Service` + `Ingress`/`HTTPRoute`, `ConfigMap`/`Secret`
  под весь env (modes, URLs, OIDC, RBAC, `DATABASE_URL`/`REDIS_URL`,
  `CHART_REGISTRY`), `ServiceAccount`, опц. `HPA`, проба `/ready`+`/health`.
- [ ] Значения чарта = единый маппинг на переменные из `.env.example`.
- [ ] Опубликовать чарт в Harbor и (по желанию) завести сам портал как заказ -
  dogfooding.

## 2. Конфигурируемая область мониторинга GitLab (через env)

Сейчас область «что мониторим в GitLab» задана в двух местах и частично жёстко:
портал знает `GITLAB_GITOPS_GROUP` + `GITLAB_TEAM_SUBGROUP_TEMPLATE`, а bootstrap
ApplicationSet (`deployments/kind/applicationset.yaml`) **хардкодит**
`group: "managed-services"`, `includeSubgroups: true`, `allBranches: false`.

- [ ] Сделать структуру (какие группы/подгруппы/папки и ветки сканировать)
  **единым источником через env**: список групп/паттерн подгрупп/ветки -
  переменные окружения, на которые опираются и портал, и генератор ApplicationSet.
- [ ] Поддержать несколько групп (не только `managed-services`) и явный шаблон
  пути инстанса (`{cluster}/{service}` сейчас зашит в `gitops.go`).
- [ ] ApplicationSet не должен содержать литералов - генерировать/темплейтить из
  той же конфигурации (или из значений Helm-чарта портала, см. п.1).

## 3. Горизонтальное масштабирование (техдолг, см. `docs/idp-spec.md`)

- [ ] Redis Pub/Sub вместо in-process event bus (`internal/events`).
- [ ] Leader election для фонового поллера (`internal/status`/reconcilers), чтобы
  запускать >1 реплики. Сейчас осознанно single-replica.

## 4. Полировка фронта

- [ ] Категории продуктов (`web/src/components/icons.tsx`) пока статичные -
  привязать к реальной таксономии из Harbor (проект → категория, репо → продукт).
- [ ] Поиск / фильтр в каталоге чартов.
- [ ] Дифф values при апдейте заказа.
- [ ] Ленивая загрузка Monaco (бандл ~544 КБ).
- [ ] «Applications» (`/applications`) - роут жив, решить, нужен ли пункт в меню.
- [ ] Persist свёрнутого меню и адаптив под узкие экраны.

## 5. OIDC внутри Docker

- [ ] Сейчас compose-портал в `AUTH_MODE=dev`, а OIDC-флоу гоняется хостовым
  `run-oidc.ps1` (нужен единый issuer для браузера и портала). Для честного OIDC
  внутри Docker - общий hostname/issuer (`host.docker.internal` или внешний домен).

## 6. Вебхуки вместо поллинга (опционально)

- [ ] `STATUS_UPDATE_MODE`, `HARBOR_WEBHOOK_SECRET`, `GITLAB_WEBHOOK_TOKEN` уже
  есть в конфиге, но не подключены. Приём вебхуков GitLab (MR merged) и Harbor
  (push чарта) дал бы мгновенную реакцию вместо тика поллера.

---

Приоритет «следующего большого шага» - **п.1 (Helm-чарт портала)** и
**п.2 (env-конфигурируемый мониторинг GitLab)**.
