# Локальный e2e-стенд: KinD + Argo CD + Harbor + GitLab

Поднимает одноузловой KinD-кластер и связывает всё так, чтобы **полная петля
работала на настоящем кластере**: заказ в портале -> IDP коммитит
`values.yaml` + `application.yaml` в реальный GitLab и открывает MR -> авто-merge
-> Argo CD деплоит чарт из Harbor в KinD -> статус возвращается в портал
(`DEPLOYING` -> `Progressing`/`HEALTHY`).

Это опциональный тяжёлый режим. Для повседневной разработки достаточно dev-loop из
корневого [`README.md`](../../README.md) (`make infra` + `make run` + `make web`,
fake-upstream'ы). Стенд нужен, только когда надо прогнать настоящий GitOps на
реальных GitLab/Harbor/Argo CD.

## Требования

- Docker Desktop, `kind`, `kubectl`, `helm` (v3.13+/v4).
- Доступ в интернет: скрипты при каждом подъёме тянут манифесты Argo CD, Gateway
  API, istio, MetalLB и чарт Harbor.
- **Только Windows/PowerShell** (стенд - набор `*.ps1`).
- Ресурсы: подъём ~10-15 мин, GitLab CE ~4 ГБ ОЗУ.

> **Секреты стенда - только для локалки.** GitLab-токен `glpat-localdev...`, Harbor
> `admin` / `Harbor12345`, Argo admin `admin12345`, GitLab root
> `changeme-please-12345` зашиты намеренно для удобства dev-стенда. Нигде не
> переиспользовать.

## Версии (запинены для воспроизводимости)

KinD node `v1.33.7`, Argo CD `v3.4.3`, istiod + istio/base `1.30.1`, Harbor chart
`1.19.1`, Gateway API `v1.2.1` (experimental-канал), MetalLB `v0.14.8`, GitLab CE
`17.5.1`. Бампить осознанно (править в соответствующих `*.ps1` / compose) и
перепроверять подъём.

## Запуск с нуля (полный e2e, по порядку)

Все команды - из корня репозитория, Windows/PowerShell. Порядок важен: каждый шаг
зависит от предыдущего.

**Шаг 0 (опционально, но до `make stand-up`) - источник чартов.** Репозиторий
chart-agnostic: деплоить нечего, пока в Harbor нет чартов. Укажи каталог с чартами
(по одной подпапке на чарт с `Chart.yaml`) - иначе шаг пуша просто пропустится и
каталог портала будет пуст:
```powershell
$env:STAND_CHARTS_DIR = "D:\path\to\charts"
```

**Шаг 1 - стенд.** KinD + Argo CD + CoreDNS-патч + CRDs + istio/MetalLB + Harbor +
проект + (опционально) пуш чартов + Argo-репозитории + ApplicationSet. ~10-15 мин;
в конце скрипт сам пишет `ARGOCD_TOKEN` в `deployments/.env`:
```powershell
make stand-up
```

**Шаг 2 - поднять стек.** Два варианта (выбери один):

- **Вариант A - всё в Docker** (portal + web в контейнерах; no-source запуск/демо):
  ```powershell
  make up-upstreams
  ```
- **Вариант B - portal + web локально** (хотрелоад): в Docker только бэкенд-сервисы
  (GitLab + Postgres + Valkey + Keycloak), а portal и web запускаем из исходников
  (шаг 5):
  ```powershell
  make up-upstreams-infra
  ```

В обоих GitLab тяжёлый (~4 ГБ, грузится 3-5 мин), стартует detached.

**Шаг 3 - дождаться, пока GitLab healthy** (без этого `gitlab-seed` упадёт):
```powershell
docker compose -f deployments/docker-compose.yml -f deployments/docker-compose.upstreams.yml ps
# healthcheck GitLab: статус (healthy) в колонке STATUS
```

**Шаг 4 - засеять GitLab** (группа `managed-services`, команды, фиксированный
API-токен). Только ПОСЛЕ healthy:
```powershell
make gitlab-seed
```

**Шаг 5 - только для варианта B: portal + web локально** (два терминала). Портал в
real-режиме читает `ARGOCD_TOKEN` из `deployments/.env`; скрипт сам останавливает
контейнерный `portal` (освобождает :8080) и поднимает Keycloak. URL'ы апстримов -
через опубликованные хост-порты (`localhost:8929/8083/8084`), `host.docker.internal`
host-side для этого пути не нужен:
```powershell
# терминал 1 - backend (real GitLab + Harbor + Argo CD, логин через Keycloak)
powershell -ExecutionPolicy Bypass -File deployments/scripts/run-oidc.ps1 -RealGitlab
# терминал 2 - frontend (Vite, live-reload)
make web
```
(Для варианта A портал уже в контейнере, этот шаг пропускаешь.)

Готово. Открыть портал: **вариант A - http://localhost:8088**, **вариант B -
http://localhost:5173**. Проверка полной петли - раздел
[«e2e-проверка»](#e2e-проверка) ниже.

### Доступы

| Что | URL | Логин |
|---|---|---|
| Портал SPA - вариант A (в Docker, dev-auth) | http://localhost:8088 | заголовки `X-Dev-*` (nginx) |
| Портал SPA - вариант B (локально, Vite) | http://localhost:5173 | Keycloak OIDC: `alice`/`alice`, `padmin`/`padmin`, `support`/`support`, `security`/`security` |
| Backend portal | http://localhost:8080 | `/health`, `/ready`, `/metrics` |
| Argo CD | http://127.0.0.1:8083 | `admin` / `admin12345` |
| Harbor | https://127.0.0.1:8084 | `admin` / `Harbor12345` |
| GitLab | http://host.docker.internal:8929 | `root` / `changeme-please-12345` |

`host.docker.internal` host-side резолвится не на всех Docker-setup'ах (см.
[риск 6](#известные-риски--тонкие-места)). Поэтому host-проверки идут на
`127.0.0.1`, а локальный портал варианта B (`run-oidc.ps1 -RealGitlab`) ходит на
апстримы по `localhost`. Имя `host.docker.internal` обязательно только для GitLab UI
в браузере (redirect на `external_url`) и для пуша чартов (`make stand-charts`).

### Снести

```powershell
make stand-down       # удаляет KinD-кластер
make down-upstreams   # останавливает контейнеры стека + volume'ы (GitLab/Postgres/Valkey/...)
```

### Полезное между подъёмами

- `make stand-token` - перевыпустить `ARGOCD_TOKEN` в `.env` (например, после
  пересоздания стенда), без полного `stand-up`.
- `make stand-charts` (со `STAND_CHARTS_DIR`) - перезалить только чарты в Harbor,
  не трогая кластер.
- `make stand-appset` - переприменить bootstrap-ApplicationSet.
- `make stand-reset` - сбросить демо-состояние (Postgres + Valkey + Argo CD
  Applications + GitLab-репо заказов), не пересобирая кластер; Harbor с чартами и
  сам KinD остаются. Деструктивно.

## Архитектура

- **Единое имя для GitLab - `host.docker.internal:8929`.** Оно резолвится из хоста,
  из контейнера portal (через `extra_hosts: host-gateway`) и из подов KinD (после
  патча CoreDNS, `10-coredns.ps1`). Поэтому `repoURL` в Application одинаков везде,
  и ссылки на MR кликабельны из браузера.
- **Argo CD** - `argocd-server` в insecure-режиме (plain HTTP), опубликован на
  хост-порт `8083` через NodePort 30083 (`kind-config.yaml` `extraPortMappings`).
  Админу выдана capability `apiKey`, чтобы выпустить долгоживущий `ARGOCD_TOKEN`
  (`token.ps1`). Интервал реконсиляции ужат до 30с.
- **Harbor** (`harbor-helm`, минимальный: Trivy off, **самоподписанный TLS**,
  persistent PVC через local-path StorageClass KinD - реестр обязан хранить блобы
  между перекатами пода, иначе emptyDir теряет их и push даёт 500). Один реестр
  отдаёт И API v2.0 (каталог портала читает его), И OCI-registry (Argo тянет
  чарты). Опубликован на хост-порт `8084` (NodePort 30084) - **тем же именем**
  `host.docker.internal`, что и GitLab. Проект `platform` создаётся **public**
  (`45-harbor-project.ps1`) -> анонимный pull и анонимное чтение каталога (creds не
  нужны); push (`50-charts.ps1`) - под `admin`. Раскладка чартов -
  `docs/chart-convention.md`.
- **Argo всегда апгрейдит OCI до HTTPS** -> Harbor обязан говорить по TLS; Argo и
  `helm` пропускают проверку самоподписанного серта (`insecure: true` /
  `--insecure-skip-tls-verify`).
- **`CHART_REGISTRY`** (env у бэка) - база OCI для chart-source в `application.yaml`.
  На стенде `host.docker.internal:8084` (тот же хост, что `HARBOR_URL`); в проде -
  Harbor.
- **IDP коммитит полноценный `application.yaml`** (`kind: Application`,
  multi-source) рядом с `values.yaml` в папке заказа `<service>/`: source 0 - чарт
  из OCI (`{CHART_REGISTRY}/{chart_project}`), source 1 - этот же git-репо
  (`ref: values`), а `helm.valueFiles: $values/<service>/values.yaml` подмешивает
  соседний values. Манифест самодостаточен.
- **app-of-apps ApplicationSet** (`applicationset.yaml`, `kind: ApplicationSet`) -
  единый generic-механизм без перечисления репо: SCM-provider (GitLab) авто-находит
  ВСЕ репозитории группы `managed-services` (incl. подгруппы) и на каждый создаёт
  directory-`Application`, который рекурсивно применяет `<service>/application.yaml`.
  Новые репо/сервисы подхватываются автоматически.

## Скрипты и порядок

`up.ps1` оркеструет шаги (каждый можно запускать отдельно, идемпотентны где
возможно):

| # | Скрипт | Что делает |
|---|---|---|
| 1 | `00-cluster.ps1` | Создаёт одноузловой KinD-кластер `idp` (`kind-config.yaml`). |
| 2 | `20-argocd.ps1` | Ставит Argo CD (server-side apply), insecure-HTTP, NodePort 30083, `apiKey` для admin. |
| 3 | `10-coredns.ps1` | Патчит CoreDNS: `host.docker.internal` -> IPv4-gateway сети `kind` (резолв из подов). |
| 4 | `30-crds.ps1` | Gateway API (experimental) + istio CRDs (без контроллеров). |
| 5 | `35-istio.ps1` | istiod + MetalLB (чтобы Gateway стал `Programmed`). |
| 6 | `40-harbor.ps1` | Ставит Harbor через `harbor-helm`, ждёт `/api/v2.0/health`. |
| 7 | `45-harbor-project.ps1` | Создаёт public-проект `platform`. |
| 8 | `50-charts.ps1` | Пушит чарты из `STAND_CHARTS_DIR` (если задан; иначе skip). |
| 9 | `60-argo-repos.ps1` | Регистрирует Argo-секреты: GitLab repo-creds, OCI-repo Harbor, SCM-token + AppProject. |
| 10 | `70-appset.ps1` | Применяет bootstrap-ApplicationSet. |
| 11 | `token.ps1` | Печатает пароль admin Argo CD и пишет `ARGOCD_TOKEN` в `deployments/.env`. |

`down.ps1` удаляет кластер. `35-istio.ps1` ставит istiod (`GatewayClass istio`) и
MetalLB (LoadBalancer-IP), без них Gateway не станет `Programmed`, а приложение -
`Healthy`.

## e2e-проверка

1. `kubectl get pods -n argocd` - все Running.
2. CoreDNS-резолв: `kubectl run dnstest --rm -it --image=busybox --restart=Never -- nslookup host.docker.internal`.
3. Чарт в реестре: `helm pull oci://host.docker.internal:8084/platform/ingress-gateway --version 3.1.0 --insecure-skip-tls-verify`
   (или Harbor API: `curl -sk https://127.0.0.1:8084/api/v2.0/projects/platform/repositories`).
4. Argo API: `curl -H "Authorization: Bearer $env:ARGOCD_TOKEN" http://127.0.0.1:8083/api/v1/version`.
5. Заказ (dev-auth, команда `core`; тело `values` - см. конвенцию чарта):
   ```bash
   curl -X POST http://localhost:8080/api/v1/requests -H 'Content-Type: application/json' \
     -H 'X-Dev-Sub: alice' -H 'X-Dev-Teams: core' -H 'X-Dev-Role: member' \
     -d '{"chart":"platform/ingress-gateway","version":"3.1.0","team":"core","service_name":"demo-gw","values":{...}}'
   ```
   -> `status: MR_CREATED`, `argocd_app_name: core-demo-gw`.
6. MR авто-мёржится поллером -> `MR_MERGED`.
7. SCM-provider находит репо (<=60с) и создаёт directory-app `repo-<chart>-<hash>`;
   тот применяет `<service>/application.yaml`. Проверка:
   `kubectl get applications -n argocd -l idp.service=demo-gw` -> появляется `core-demo-gw`.
8. `kubectl describe application core-demo-gw -n argocd` -> два source (OCI chart 3.1.0 + git `$values`), `Synced`/`Progressing`.
9. `GET /api/v1/requests/<id>` -> `MR_MERGED` -> `DEPLOYING` -> `Progressing`/`HEALTHY`.
10. Удаление: `DELETE /requests/<id>` -> MR убирает папку -> directory-app prune -> child `Application` удаляется -> портал `DELETED`.

## Известные риски / тонкие места

1. **`host.docker.internal` в подах KinD** - чинится патчем CoreDNS
   (`10-coredns.ps1`, gateway сети `kind`). Без него Argo не склонирует git-source.
   Фолбэк: подключить kind-ноду к compose-сети и DNS-имя `gitlab` (хуже - меняет
   `repoURL`).
2. **OCI поверх HTTP не работает в Argo** - Argo CD (helm-клиент) всегда апгрейдит
   OCI до HTTPS (`server gave HTTP response to HTTPS client`). Поэтому реестр здесь
   на самоподписанном TLS, а Argo пропускает проверку через `insecure: true`
   (= `helm --insecure-skip-tls-verify`). Plain-HTTP через поле репозитория в v3.4
   для `type: helm` недоступен.
3. **Healthy и Gateway** - после istiod + MetalLB Gateway становится
   `Accepted+Programmed=True`. Приложение становится `Healthy`, **только если
   маршруты заказа валидны**: `parentRef`/`sectionName` совпадает с listener'ом
   Gateway и `backendRefs` указывают на существующие Service. Иначе HTTPRoute
   `Accepted=False (NoMatchingParent)` / `ResolvedRefs=False (BackendNotFound)` ->
   приложение `Degraded` (это данные заказа, не инфраструктура). Gateway API
   ставится из **experimental**-канала (нужны TCP/TLS/UDP-routes чарта).
4. **Образ ноды KinD** закреплён на `v1.33.7`: дефолтный `v1.35.0` не поднимает
   kubelet на Docker Desktop/WSL2 (`required cgroups disabled`).
5. **Установка Argo - server-side apply** (`--server-side --force-conflicts`): CRD
   `applicationsets` слишком велик для client-side apply (аннотация > 256 КБ).
   Манифест перед apply скачивается и патчится: единственный образ из
   `public.ecr.aws` (`argocd-redis`) перенаправляется на Docker Hub
   (`redis:*-alpine`), т.к. в части сетей нет доступа к AWS ECR Public. Образы
   argocd (quay.io) и dex (ghcr.io) не трогаются.
6. **`host.docker.internal` со стороны хоста.** Host-side проверки в скриптах
   (`40-harbor.ps1` health, `45-harbor-project.ps1`, `token.ps1`) ходят на
   `127.0.0.1`, а не на `host.docker.internal`: NodePort'ы опубликованы на loopback
   хоста, а `host.docker.internal` резолвится host-side только если Docker Desktop
   прописал его в hosts-файл. Если нет - `curl` к `host.docker.internal:8084` даёт
   `code 000`, хотя Harbor жив на `127.0.0.1:8084`. Но **пуш чартов**
   (`50-charts.ps1`) и доступ к **GitLab** всё равно требуют резолва
   `host.docker.internal` host-side: OCI-push по token-realm редиректит на
   `externalURL` (= `host.docker.internal:8084`), а GitLab привязан к этому имени
   как единому `repoURL`. Если имя не резолвится - добавь строку
   `127.0.0.1 host.docker.internal` в `C:\Windows\System32\drivers\etc\hosts` (от
   админа). Рантайм портала (контейнер) резолвит `host.docker.internal` сам через
   Docker, hosts-файл хоста ему не нужен.
