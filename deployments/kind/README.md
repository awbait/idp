# Локальный e2e-стенд: KinD + Argo CD + реальный GitLab

Поднимает одноузловой KinD с Argo CD и связывает всё так, чтобы **полная петля
работала на настоящем кластере**: заказ в портале → IDP коммитит
`values.yaml`+`application.yaml` в реальный GitLab и открывает MR → авто-merge →
Argo CD деплоит чарт в KinD → статус возвращается в портал
(`DEPLOYING` → `Progressing`/`HEALTHY`).

Требуется: Docker Desktop, `kind`, `kubectl`, `helm` (v3.13+/v4), доступ в интернет
(скрипты тянут манифесты Argo/istio/MetalLB/Harbor при каждом подъёме). Только
Windows/PowerShell. Тяжёлый: ~10+ мин на подъём, GitLab CE ~4 ГБ ОЗУ.

> **Секреты стенда - только для локалки.** GitLab-токен `glpat-localdev…`, Harbor
> `admin/Harbor12345`, Argo admin `admin12345`, GitLab root `changeme-please-12345`
> зашиты намеренно для удобства dev-стенда. Нигде не переиспользовать.

## Версии (запинены для воспроизводимости)

KinD node `v1.33.7`, Argo CD `v3.4.3`, istiod + istio/base `1.30.1`, Harbor chart
`1.19.1`, Gateway API `v1.2.1` (experimental), MetalLB `v0.14.8`. Бампить осознанно
(править в соответствующих `*.ps1`) и перепроверять подъём.

## Архитектура

- **Единое имя для GitLab - `host.docker.internal:8929`** - резолвится из хоста,
  из контейнера portal и (после патча CoreDNS) из подов KinD. Поэтому `repoURL` в
  Application одинаков везде.
- **Argo CD** - `argocd-server` в insecure-режиме (HTTP), опубликован на
  `host.docker.internal:8083` через NodePort 30083 (`kind-config.yaml`
  `extraPortMappings`).
- **Harbor** (`harbor-helm`, минимальный: Trivy off, **самоподписанный TLS**,
  persistent volumes через local-path StorageClass KinD - registry обязан хранить
  блобы между перекатами пода, иначе emptyDir теряет их и push даёт 500) -
  настоящий реестр, отдаёт И API v2.0 (каталог портала
  читает его), И OCI-реестр (Argo тянет чарты). Опубликован на
  `host.docker.internal:8084` (NodePort 30084) - **тем же именем**, что и GitLab,
  поэтому host/container/поды KinD (через CoreDNS) резолвят его одинаково. Argo CD
  всегда апгрейдит OCI до HTTPS → Harbor обязан говорить по TLS; Argo и `helm`
  пропускают проверку (`insecure: true` / `--insecure-skip-tls-verify`). Проект
  `platform` создаётся **public** (`45-harbor-project.ps1`) → анонимный pull и
  анонимное чтение каталога (creds не нужны); push (`50-charts.ps1`) - под admin
  (`admin` / `Harbor12345`). Раскладка чартов - `docs/chart-convention.md`.
- **IDP коммитит полноценный `application.yaml`** (`kind: Application`,
  multi-source) рядом с `values.yaml` в папке заказа `<service>/`: source 0 - чарт
  из OCI (`{CHART_REGISTRY}/{chart_project}`), source 1 - этот же git-репо
  (`ref: values`), а `helm.valueFiles: $values/<service>/values.yaml` подмешивает
  соседний values. Манифест самодостаточен.
- **`CHART_REGISTRY`** (env у бэка) - база OCI для chart-source. На стенде
  `host.docker.internal:8084` (тот же хост, что HARBOR_URL); в проде - Harbor.
- **app-of-apps ApplicationSet** (`applicationset.yaml`, `kind: ApplicationSet`) -
  единый generic-механизм без перечисления репо: SCM-provider (GitLab) авто-находит
  ВСЕ репозитории группы `managed-services` (incl. подгруппы) и на каждый создаёт
  directory-`Application`, который рекурсивно применяет `<service>/application.yaml`
  как CR. Новые репо/сервисы подхватываются автоматически.

## Запуск с нуля (полный e2e)

Порядок и ожидания важны: каждый шаг зависит от предыдущего. Всё на
Windows/PowerShell.

**Шаг 0 - предусловие: чарты.** Репозиторий chart-agnostic, деплоить нечего, пока
в Harbor нет чартов. Укажи каталог с чартами (по одной папке на чарт с
`Chart.yaml`) ДО `make stand-up`, иначе шаг пуша пропустится и каталог портала
будет пуст:
```powershell
$env:STAND_CHARTS_DIR = "D:\path\to\charts"
```

**Шаг 1 - стенд** (KinD + Argo CD + Harbor + istio + пуш чартов + app-of-apps).
~10-15 мин; в конце сам пишет `ARGOCD_TOKEN` в `deployments/.env`:
```powershell
make stand-up
```

**Шаг 2 - GitLab + портал** в real-режиме (читает `ARGOCD_TOKEN` из `.env`). GitLab
тяжёлый (~4 ГБ, грузится 3-5 мин), запускается detached:
```powershell
make up-upstreams
```

**Шаг 3 - дождаться, пока GitLab healthy** (без этого `gitlab-seed` упадёт):
```powershell
docker compose -f deployments/docker-compose.yml -f deployments/docker-compose.upstreams.yml ps
# или: curl.exe -s http://host.docker.internal:8929/-/health
```

**Шаг 4 - засеять GitLab** (группа `managed-services` + команды + фиксированный
токен). Только ПОСЛЕ healthy:
```powershell
make gitlab-seed
```

Готово. Доступ: портал (SPA, dev-auth) - http://localhost:8088, Argo CD -
http://host.docker.internal:8083, Harbor - https://host.docker.internal:8084
(`admin`/`Harbor12345`), GitLab - http://host.docker.internal:8929. Проверить
полную петлю - раздел «e2e-проверка» ниже.

**Снести:** `make stand-down` (KinD-кластер) + `make down-upstreams` (GitLab/портал).

`ARGOCD_TOKEN` пишется в `.env` автоматически (шаг `token.ps1`); перевыпустить
после пересоздания стенда - `make stand-token`. Перезалить только чарты, не трогая
кластер - `make stand-charts` со `STAND_CHARTS_DIR`.

## e2e-проверка

1. `kubectl get pods -n argocd` - все Running.
2. CoreDNS-резолв: `kubectl run dnstest --rm -it --image=busybox --restart=Never -- nslookup host.docker.internal`.
3. Чарт в реестре: `helm pull oci://host.docker.internal:8084/platform/ingress-gateway --version 3.1.0 --insecure-skip-tls-verify`
   (или Harbor API: `curl -sk https://host.docker.internal:8084/api/v2.0/projects/platform/repositories`).
4. Argo API: `curl -H "Authorization: Bearer $env:ARGOCD_TOKEN" http://host.docker.internal:8083/api/v1/version`.
5. Заказ (dev-auth, команда `core`; тело `values` - см. `charts/ingress-gateway/minimal-values.yaml`):
   ```bash
   curl -X POST http://localhost:8080/api/v1/requests -H 'Content-Type: application/json' \
     -H 'X-Dev-Sub: alice' -H 'X-Dev-Teams: core' -H 'X-Dev-Role: member' \
     -d '{"chart":"platform/ingress-gateway","version":"3.1.0","team":"core","service_name":"demo-gw","values":{...}}'
   ```
   → `status: MR_CREATED`, `argocd_app_name: core-demo-gw`.
6. MR авто-мёржится поллером → `MR_MERGED`.
7. SCM-provider находит репо (≤60с) и создаёт directory-app `repo-<chart>-<hash>`;
   тот применяет `<service>/application.yaml`. Проверка:
   `kubectl get applications -n argocd -l idp.service=demo-gw` → появляется `core-demo-gw`.
8. `kubectl describe application core-demo-gw -n argocd` → два source (OCI chart 3.1.0 + git `$values`), `Synced`/`Progressing`.
9. `GET /api/v1/requests/<id>` → `MR_MERGED` → `DEPLOYING` → `Progressing`/`HEALTHY`.
10. Удаление: `DELETE /requests/<id>` → MR убирает папку → directory-app prune → child `Application` удаляется → портал `DELETED`.

## Скрипты

`up.ps1` оркеструет: `00-cluster` → `20-argocd` → `10-coredns` → `30-crds` →
`35-istio` → `40-harbor` → `45-harbor-project` → `50-charts` → `60-argo-repos` →
`70-appset` → `token`. Каждый можно запускать отдельно (идемпотентны где возможно).
`40-harbor.ps1` ставит Harbor через `harbor-helm` (values - `harbor-values.yaml`) и
ждёт `/api/v2.0/health`. `35-istio.ps1` ставит istiod + MetalLB, чтобы Gateway
(`gatewayClassName: istio`) был `Programmed` и приложение могло стать `Healthy`.

## Известные риски / тонкие места

1. **`host.docker.internal` в подах KinD** - чинится патчем CoreDNS
   (`10-coredns.ps1`, gateway сети `kind`). Без него Argo не склонирует git-source.
   Фолбэк: подключить kind-ноду к compose-сети и DNS-имя `gitlab` (хуже - меняет
   `repoURL`).
2. **OCI поверх HTTP не работает в Argo** - Argo CD (helm-клиент) всегда апгрейдит
   OCI до HTTPS (`server gave HTTP response to HTTPS client`). Поэтому реестр здесь
   на самоподписанном TLS, а Argo пропускает проверку через `insecure: true`
   (= `helm --insecure-skip-tls-verify`). Plain-http через поле репозитория в
   v3.4 недоступно для `type: helm`.
3. **Healthy и Gateway** - `35-istio.ps1` ставит istiod (регистрирует
   `GatewayClass istio` и программирует Gateway) + MetalLB (даёт LoadBalancer-IP в
   KinD, иначе Gateway `Programmed=False/AddressNotAssigned`). После этого Gateway
   `Accepted+Programmed=True`. Приложение становится `Healthy`, **только если
   маршруты заказа валидны**: `parentRef`/`sectionName` совпадает с listener'ом
   Gateway и `backendRefs` указывают на существующие Service. Иначе HTTPRoute
   `Accepted=False (NoMatchingParent)` / `ResolvedRefs=False (BackendNotFound)` →
   приложение `Degraded` (это данные заказа, не инфраструктура). Gateway API
   ставится из **experimental**-канала (нужны TCP/TLS/UDP routes чарта).
4. **Образ ноды KinD** закреплён на `v1.33.7`: дефолтный `v1.35.0` не поднимает
   kubelet на Docker Desktop/WSL2 (`required cgroups disabled`).
5. **Установка Argo - server-side apply** (`--server-side --force-conflicts`): CRD
   `applicationsets` слишком велик для client-side apply (аннотация > 256 КБ).

## Про `kind: Application` vs `kind: ApplicationSet`

`Application` **не устарел** - это базовый CRD, единица деплоя (один инстанс).
`ApplicationSet` - это «фабрика», которая по генератору (git/scm/list) **создаёт
множество** `Application`. Это разные сущности, а не замена одной другой.

Поэтому в стенде два слоя с разными kind:
- то, что IDP коммитит на КАЖДЫЙ заказ - `kind: Application` (`<service>/application.yaml`):
  один сервис = один Application;
- bootstrap (`deployments/kind/applicationset.yaml`) - `kind: ApplicationSet`: он
  обнаруживает репо и создаёт directory-`Application`, которые применяют те самые
  закоммиченные `Application`.

Коммитить `kind: ApplicationSet` на каждый сервис смысла нет (ApplicationSet
генерирует приложения, а не описывает один инстанс).
