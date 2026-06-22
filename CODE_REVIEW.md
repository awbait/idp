# Код-ревью: анализ проблем, уязвимостей и ошибок

Дата: 2026-06-19
Ветка: `main` (HEAD `41a3bd7`)
Охват: весь Go-бэкенд (`cmd/`, `internal/`, `collector/`, `pkg/`), ~13.7k строк.
Метод: статический анализ по подсистемам (auth/RBAC, HTTP-слой, хранилище, интеграции/провижининг). Каждая находка подтверждена кодом; помеченные «требует проверки» зависят от внешней модели угроз.

## Сводка по серьёзности

| ID | Серьёзность | Подсистема | Суть |
|----|-------------|------------|------|
| C1 | Critical | auth | `SESSION_SECRET` объявлен, но не используется: токены лежат в Redis в plaintext |
| C2 | Critical | api/catalog | Обход allowlist чартов (BOLA) по прямому URL |
| H1 | High | api | Паника при старте / небезопасный `Secure`-флаг cookie из `PublicURL[:5]` |
| H2 | High | auth | Не проверяется OIDC `nonce` |
| H3 | High | store | Нет транзакций «переход заказа + аудит/MR»; ошибка `AddEvent` глушится |
| H4 | High | harbor | Скачанный blob чарта не сверяется с дайджестом |
| M1 | Medium | auth | Нет защиты от накопления/фиксации сессий, нет отзыва |
| M2 | Medium | auth | Silent-refresh не перевычисляет роли (залипание отозванных прав) |
| M3 | Medium | auth | Широкий матчинг RBAC-групп по любому сегменту пути |
| M4 | Medium | auth | `Logout` по GET без CSRF; `SameSite=Lax` на session-cookie |
| M5 | Medium | api | Нет лимита на размер тела запроса (`MaxBytesReader`) |
| M6 | Medium | api | Неполные таймауты сервера (нет `IdleTimeout`/`ReadTimeout`/`MaxHeaderBytes`) |
| M7 | Medium | api | SSE без лимита числа соединений |
| M8 | Medium | api | Утечка сырых ошибок апстрима на `/ready` и `charts/check` |
| M9 | Medium | harbor/provisioning | SSRF/инъекция пути в Harbor URL через импортированные манифесты |
| M10 | Medium | provisioning | Path traversal: `Cluster` не валидируется и попадает в git-пути/манифесты |
| M11 | Medium | store | Нет advisory-lock - гонка миграций между репликами |
| M12 | Medium | store | Нет страховочных таймаутов на фоновых путях к БД |
| M13 | Medium | store | Игнор ошибки `json.Marshal` payload аудита |
| M14 | Medium | provisioning | `HARBOR_INSECURE_TLS=true` в dev-скрипте, риск протечь в прод |
| L1-L13 | Low | разное | См. раздел Low ниже |

Живых SQL-инъекций, гонок в shared-памяти, утечек соединений к БД, path traversal в раздаче SPA - не обнаружено (см. «Проверено - чисто»).

---

## Critical

### C1. `SESSION_SECRET` объявлен, но не используется - токены в Redis в plaintext
Файлы: `internal/config/config.go:47`, `internal/auth/session.go:13-22,38-48`, `cmd/portal/main.go:278`

`SESSION_SECRET` (дефолт `dev-insecure-session-secret-change-me`) объявлен в конфиге, но grep по всему репозиторию (`SessionSecret`) находит только эту строку-объявление - значение нигде не читается. Комментарий в `session.go` это признаёт: «the skeleton stores plain JSON (TODO: wrap with secretbox/AES-GCM)». В Redis в открытом виде лежат `access_token`, `refresh_token`, `id_token` и профиль каждого пользователя. Любой, кто читает Redis (дамп, реплика, бэкап, общая сеть), получает все OIDC-токены активных пользователей и может выдавать себя за них во внешних системах. Небезопасный дефолт секрета создаёт ложное ощущение настроенного шифрования.

Рекомендация: либо реально шифровать значение сессии (AES-GCM/secretbox на ключе из `SESSION_SECRET`) перед `cache.Set` и расшифровывать в `Get`, либо убрать вводящую в заблуждение переменную и зафиксировать в доке требование к изоляции/TLS Redis. Не оставлять небезопасный дефолт, который ни на что не влияет.

### C2. Обход allowlist чартов (BOLA) по прямому URL
Файлы: `internal/api/handlers_catalog.go:21-91` -> `internal/catalog/service.go:62-109`

`ListCharts` (service.go:47) фильтрует выдачу через `VisibleTo` (allowlist `AllowedTeams` + admin). Но `GetChart`/`GetVersion`/`GetValues`/`GetReadme`/`GetSchema`/`GetChangelog` НЕ принимают пользователя и НЕ вызывают `VisibleTo`, а хендлеры (`handleGetChart` и далее) вызывают их без `auth.UserFrom`. Подтверждено фикстурой `internal/harbor/fake.go`: чарт `platform/redis` ограничен командой `core`. Любой аутентифицированный пользователь не из `core`, зная путь, прочитает описание, версии, `values.yaml`, `values.schema.json`, README и changelog в обход allowlist. Чарт не виден в списке, но доступен напрямую.

Рекомендация: пробрасывать `auth.UserFrom(r.Context())` в эти методы и проверять `VisibleTo` (как уже сделано в `handleCatalog`, handlers_catalog.go:12). Возвращать 404 (не 403), чтобы не раскрывать существование чарта.

---

## High

### H1. Паника при старте / небезопасный `Secure`-флаг cookie
Файл: `cmd/portal/main.go:299` - `Secure: cfg.PublicURL[:5] == "https"`

Два дефекта в одной строке:
1. Паника/DoS на старте: `cfg.PublicURL[:5]` - срез фиксированной длины. Если `PUBLIC_URL` короче 5 символов (опечатка, пустое/короткое значение) - `slice bounds out of range`, процесс не стартует.
2. Хрупкая логика: при TLS-терминации на ingress частый кейс `PUBLIC_URL=http://...` даст `Secure=false`, и session-cookie уйдёт по HTTP - тихий небезопасный дефолт.

Рекомендация: `strings.HasPrefix(cfg.PublicURL, "https://")` или `url.Parse` с проверкой `Scheme`. Сделать `Secure` явно конфигурируемым (`COOKIE_SECURE`, дефолт `true`).

### H2. Не проверяется OIDC `nonce`
Файл: `internal/auth/oidc.go:64,126-169`

В Authorization Code flow генерируется и проверяется только `state`. `nonce` не передаётся в `AuthCodeURL` и не сверяется в `id_token` (`idToken.Nonce`). Снижает защиту от replay/injection `id_token`. Для confidential client с code flow риск ниже, чем для implicit, но проверка nonce - требование best practice OIDC.

Рекомендация: генерировать криптослучайный `nonce`, класть в короткоживущую HttpOnly-cookie (как `oauth_state`), добавлять `oidc.Nonce(nonce)` в `AuthCodeURL`, сверять `idToken.Nonce` в callback.

### H3. Нет транзакций «переход заказа + аудит/MR»; ошибка `AddEvent` глушится
Файлы: `internal/provisioning/service.go:435-438,714-748`, `internal/store/store.go`

`UpdateRequest` и последующие `AddEvent`/`AddMR` - отдельные вызовы store без единой транзакции; интерфейс `Store` вообще не предоставляет транзакционного скоупа. При сбое между шагами заказ может сменить статус, а аудит/MR - не сохраниться. В `event()` (service.go:746) ошибка игнорируется (`_ =`), то есть аудит-запись может молча потеряться.

Рекомендация: ввести транзакционный метод в порт (`Tx(ctx, func(Store) error)`) и оборачивать связки «переход статуса + событие» в одну транзакцию; как минимум - логировать ошибку `AddEvent` (Warn/Error), а не глушить.

### H4. Скачанный blob чарта не сверяется с дайджестом
Файл: `internal/harbor/client.go:409-424` (`fetchBlob`), `:359`

Слой чарта тянется по `layer = l.Digest` из манифеста, но содержимое (`io.ReadAll`) не сверяется с этим SHA256 - а это и есть смысл content-addressable хранилища. При компрометации/подмене registry (особенно вместе с M14) портал распакует и отдаст в валидацию/каталог произвольный tgz как доверенный.

Рекомендация: считать sha256 от тела блоба и сравнить с `layer`; при несовпадении - ошибка.

---

## Medium

### M1. Нет защиты от накопления/фиксации сессий, нет отзыва
Файлы: `internal/auth/oidc.go:178-186`, `internal/auth/session.go:38-48`

Session id - `uuid` v4 (crypto/rand), при каждом логине минтится новый - это плюс. Но: при повторном логине старая серверная сессия не удаляется (накопление «живых» сессий до конца TTL); нет logout-all и привязки к устройству. Cookie - единственный bearer-секрет без подписи/привязки: её утечка = захват сессии до конца TTL (24h), отозвать конкретную сессию нельзя.

Рекомендация: при логине удалять старую серверную сессию по существующей cookie; рассмотреть отзыв всех сессий и/или снижение `SESSION_TTL`. Подпись/привязку закрывает C1.

### M2. Silent-refresh не перевычисляет роли (залипание отозванных прав)
Файл: `internal/auth/oidc.go:203-233`

При истёкшем access-token `Authenticate` молча обновляет токены, но НЕ пересобирает роли/группы (`sess.User` остаётся прежним). Если в Keycloak отозвали admin-группу или заблокировали пользователя, портал считает его прежним вплоть до конца refresh-цепочки/TTL. Fail-stale.

Рекомендация: при silent-refresh заново валидировать `id_token` и пересобирать пользователя через `rbac.BuildUser`, чтобы отзыв прав вступал в силу.

### M3. Широкий матчинг RBAC-групп по любому сегменту пути
Файлы: `internal/auth/rbac.go:74-87` (`inGroupSet`), `43-59` (`teamFor`). Требует проверки против схемы групп Keycloak.

`inGroupSet` матчит сконфигурированную группу не только как полный путь, но как любой одиночный сегмент на любой глубине: токен-группа `/org/platform-admins/sub` даёт admin. Если в IdP пользователь может создать/попасть в подгруппу с именем сегмента, совпадающим с admin/support/security, он получит роль. Fail-open в сторону повышения прав.

Рекомендация: подтвердить с моделью групп Keycloak, что произвольное вложение admin-сегмента невозможно. Для привилегированных групп (`AdminGroups/SupportGroups/SecurityGroups`) рассмотреть матчинг полного пути; «любой сегмент» оставить только для team-маппинга.

### M4. `Logout` по GET без CSRF; `SameSite=Lax` на session-cookie
Файлы: `internal/auth/oidc.go:239-269` (logout), `183-186` (session cookie)

`Logout` - state-changing операция по GET-навигации; в сочетании с `SameSite=Lax` сторонний сайт может форс-разлогинить пользователя (CSRF, уровень DoS). Session-cookie - тоже `Lax` и без `MaxAge`/`Expires` (живёт до закрытия браузера), рассинхрон с 24h серверной сессии.

Рекомендация: logout по POST с CSRF-токеном; session-cookie - `SameSite=Strict` и явный `MaxAge`, согласованный с `SessionTTL`.

### M5. Нет лимита на размер тела запроса
Файлы: хендлеры с `json.NewDecoder(r.Body).Decode(...)` - `handlers_requests.go:56,108,131`; `handlers_publications.go:32,46,102,139,161,209`; `handlers_catalog.go:333`. Сервер: `cmd/portal/main.go:206-210`

Тело декодируется без `http.MaxBytesReader`; поля `Values map[string]any` и `View json.RawMessage` принимают произвольно большой JSON. Аутентифицированный клиент может выесть память/CPU многомегабайтным телом.

Рекомендация: обернуть `r.Body = http.MaxBytesReader(w, r.Body, N)` (middleware или хелпер) с лимитом 1-4 МБ; на SSE не вешать.

### M6. Неполные таймауты сервера
Файл: `cmd/portal/main.go:206-210`

Задан только `ReadHeaderTimeout: 10s`. Нет `IdleTimeout`, `ReadTimeout`, `MaxHeaderBytes`. Простаивающие keep-alive и медленная отправка тела не ограничены. `WriteTimeout` глобально нельзя (SSE), но `IdleTimeout`/`MaxHeaderBytes` уместны.

Рекомендация: добавить `IdleTimeout` (~60-120s) и `MaxHeaderBytes`; `ReadTimeout` - осторожно (для GET-SSE тела нет, обычно безопасен).

### M7. SSE без лимита числа соединений
Файлы: `internal/api/sse.go:10-46`, `internal/api/handlers_apps.go:33-55`

Каждое SSE-подключение держит горутину, подписку и сокет до `ctx.Done()`. Утечки горутин нет (`defer unsub()`), но нет верхнего предела на число коннектов; `/requests/events` (глобальный поток) доступен любому аутентифицированному. Вместе с отсутствием rate limiting - DoS по числу горутин/дескрипторов.

Рекомендация: лимит одновременных SSE-стримов (глобально и/или на пользователя) + `IdleTimeout`.

### M8. Утечка сырых ошибок апстрима клиенту
Файлы: `internal/api/server.go:180,184` (`/ready`), `internal/api/handlers_catalog.go:351` (`charts/check`), `internal/api/system.go:115` (`/status`, только админ)

`writeDomainErr` аккуратно прячет тела для internal/not_found/forbidden, но `/ready` возвращает `"store: "+err.Error()`/`"cache: "+err.Error()` (могут содержать хост/порт/детали драйвера), а `handleCheckChart` - сырой `err.Error()` от Harbor. `/ready` публичный (до auth). Для `/status` приемлемо (только админ).

Рекомендация: на `/ready` и `charts/check` логировать `err` детально, в тело отдавать обобщённое «store unavailable»/«upstream unavailable».

### M9. SSRF/инъекция пути в Harbor URL через импортированные манифесты
Файлы: `internal/harbor/client.go:389,410` (`repo = project + "/" + name`), `internal/provisioning/import.go:151,159,179`

В `fetchManifest`/`fetchBlob` `repo` подставляется в URL сырым (в отличие от `apiGet`/`listArtifacts`, где есть `url.PathEscape`). `project`/`name` в части потоков берутся из манифеста, обнаруженного в Git (`projectFromRepoURL`, labels). `name` с `../`/`@`/хостом теоретически уводит за пределы `/v2/{project}/{name}`. Порог эксплуатации высокий (нужны права записи в GitOps-репозиторий), потому Medium.

Рекомендация: валидировать `project`/`name` по `nameRe`/whitelist перед обращением в Harbor; экранировать сегменты `repo` покомпонентно.

### M10. Path traversal: `Cluster` не валидируется
Файлы: `internal/provisioning/service.go:230-233,417-419`, `gitops.go:99-112`

`ServiceName`/`Namespace` валидируются `nameRe` (DNS-1123), traversal по ним невозможен. Но `Cluster` в `Create`/`updateDraft` не валидируется и попадает в путь коммита/values (`{cluster}/{service}`) и в `application.yaml` (`destination.name`). GitLab-путь экранируется целиком (`PathEscape`), но грязный `Cluster` (`../`, переводы строк) даёт мусорные пути/манифесты и путаницу идентичности.

Рекомендация: валидировать `Cluster` тем же `nameRe`.

### M11. Нет advisory-lock - гонка миграций между репликами [RESOLVED]
Файл: `internal/store/migrate.go`

При одновременном старте нескольких реплик каждая независимо читает `schema_migrations` и может попытаться применить одну миграцию параллельно. Дублей версий не будет (PK), но DDL может выполниться дважды/частично.

Рекомендация: брать `pg_advisory_xact_lock(<const>)` в начале накатки (как golang-migrate).

Исправлено: накатка переведена на Atlas-каталог (`*.sql` + `atlas.sum`), весь прогон сериализован session-level локом `pg_advisory_lock(<const>)` на одном выделенном соединении (`pool.Acquire`). Критический участок (создание `schema_migrations`, проверка применённых версий, применение DDL) идёт под локом, поэтому конкурирующие реплики ждут и затем пропускают уже применённые версии. Взят session-level (а не `_xact_lock`), так как каждая миграция применяется в отдельной транзакции и лок должен накрывать весь цикл.

### M12. Нет страховочных таймаутов на фоновых путях к БД
Файл: весь `internal/store/postgres.go`

Методы принимают `ctx`, но store не навешивает дедлайн. Если фоновый вызывающий (поллер `ListActive`, reconcile) передаёт ctx без таймаута, зависший запрос заблокирует соединение до исчерпания пула.

Рекомендация: на критичных фоновых путях оборачивать вызовы в `context.WithTimeout`.

### M13. Игнор ошибки `json.Marshal` payload аудита
Файлы: `internal/store/postgres.go:256`, `internal/store/postgres_publications.go:186`

`payload, _ = json.Marshal(e.Payload)` - при ошибке маршалинга в БД молча уйдёт пустой/`null` payload, аудит-событие потеряет данные без сигнала. Симметрично `json.Unmarshal` на чтении (postgres.go:283).

Рекомендация: обрабатывать ошибку (минимум Warn-лог).

### M14. `HARBOR_INSECURE_TLS=true` в dev-скрипте
Файлы: `internal/harbor/client.go:64-67`, `internal/config/config.go:69` (дефолт `false`), `deployments/scripts/run-oidc.ps1:69` (ставит `true`)

Флаг с безопасным дефолтом приемлем, но dev-скрипт включает его. Если такой конфиг просочится в прод, проверка TLS Harbor (включая Basic-обмен robot-кредами в `fetchRegistryToken`) отключается - утечка кредов и MITM. Вместе с H4 (нет проверки дайджеста) - полноценный вектор подмены чарта.

Рекомендация: дефолт `false`; задокументировать «только локальный стенд»; рассмотреть запрет включения при реальном (non-fake) Harbor-режиме.

---

## Low

- L1. `internal/auth/dev.go:32-52` - dev-аутентификатор назначает любую роль по заголовку `X-Dev-Role`. В прод-бинарь не подключён (`buildAuth` требует `AUTH_MODE=oidc`), но защита держится на одной строке. Рекомендация: вынести `Dev` под build-tag `dev`/`test`, исключив из прод-бинаря на уровне компиляции.
- L2. `internal/auth/oidc.go:89-93` - `randState` игнорирует ошибку `rand.Read`. При гипотетическом сбое - предсказуемый state без сигнала. Рекомендация: проверять ошибку и фейлить логин.
- L3. PKCE заявлен в комментарии (`oidc.go:17`), но не используется. Для confidential client допустимо; добавить как defense-in-depth.
- L4. `internal/cache/memory.go:35-38` - ленивая чистка просрочки: записи без обращения не удаляются, неограниченный рост `items`. Для тестового backend приемлемо.
- L5. `internal/store/migrate.go:39` - `name[:strings.IndexByte(name, '_')]` паникует, если в имени файла нет `_`. Рекомендация: проверять `idx > 0`.
- L6. Down-миграции существуют, но runner их не использует - откат только ручной (осознанное ограничение skeleton).
- L7. N+1 в вызывающем коде (не в store): `ListMRs`/`ListEvents` дёргаются по одному `request_id`. Наблюдение.
- L8. `models.go:130-131` - `GitLabProjectID`/`MRIID` тип `int` (Go) против `INT`/int4 (Postgres). Id > 2^31 даст переполнение на стороне БД. Рекомендация: `BIGINT` либо `int32`.
- L9. `cmd/portal/main.go:182`, `internal/status/poller.go:54-66` - при shutdown текущий тик reconcile не дренируется (нет `WaitGroup`); может остаться полузавершённое состояние в GitLab (висящая ветка).
- L10. `internal/provisioning/reconcile.go:34-37` - `autoMerge` мерджит MR без ревью. Комментарий «off in production», но опасная конфигурация. Рекомендация: fail-fast при `autoMerge=true` + реальный GitLab, либо громкий WARN при старте.
- L11. `internal/status/poller.go:54-66` - retry без backoff; `DiscoverApplications` обходит все проекты группы каждые 15s без circuit breaker. При росте каталога - риск самоDoS на GitLab. Рекомендация: экспоненциальный backoff, кэш discovery.
- L12. `internal/provisioning/gitops.go:160-189` - `application.yaml` рендерится `text/template` без YAML-экранирования. `Cluster` (M10) и `ChartVersion` со спецсимволами могут сломать/подделать структуру (YAML-инъекция). Рекомендация: `yaml.Marshal` структуры либо `%q`-квотинг скаляров.
- L13. `collector/k8s.go:50-98` - `collect` падает целиком при ошибке одного namespace; теряются данные по всем. `internal/provisioning/drift.go:46-94` - `checkDriftOne` молча проглатывает ошибки store. Рекомендация: логировать и продолжать.
- L14. Нет rate limiting ни на одном эндпоинте (`internal/api/server.go:49-142`). Все `/api/v1/*` за аутентификацией, поэтому Low. Рекомендация: базовый `httprate`/`middleware.Throttle` на тяжёлые эндпоинты (создание заказов, `charts/check`, SSE).

---

## Проверено - чисто (явно безопасно)

- SQL-инъекции: все запросы параметризованы (pgx `$1..`); динамические условия в `ListRequests`/`ListPublications` собирают только плейсхолдеры, значения идут в `args`; `ORDER BY`/`LIMIT` захардкожены.
- Гонки в memory store/cache: все методы под `mu.Lock()` и возвращают копии (`clone`), а не указатели; cache копирует байты.
- Утечки соединений: везде `defer rows.Close()` + `rows.Err()`.
- Обработка `sql.ErrNoRows`: через `errors.Is(err, pgx.ErrNoRows)` -> `ErrNotFound`; дополнительно ловится `22P02` (битый UUID).
- Оптимистичная блокировка (`UPDATE ... WHERE id=$ AND version=$`) реализована корректно в обоих backend, с различением `ErrNotFound`/`ErrStaleVersion`.
- Path traversal в SPA (`spa.go`, `internal/spa/spa.go`): read-only `embed.FS`, `path.Clean`, `X-Content-Type-Options: nosniff`. Безопасно.
- Открытый редирект в OIDC: закрыт `safeReturnTo` (отбивает `//` и `/\`).
- CSRF на OIDC callback: проверка `state` через HttpOnly-cookie.
- CORS: middleware отсутствует - для same-origin SPA это корректно, не мисконфигурация.
- IDOR на заказах: `Get`/`List`/`Update`/`Delete` проверяют команду/роль (покрыто `access_test.go`); SSE по заказу/приложению гейтится через `Prov.Get`/`Status.GetApplication`.
- Публикации: чтение намеренно глобальное (живой каталог), мутации гейтятся `canManage`/`IsAdmin`.
- XSS через API: ответы `application/json` / `text/yaml` / `text/markdown`; рендеринг на клиенте.
- Токены апстримов передаются только в заголовках (Authorization/PRIVATE-TOKEN/Basic), не в URL.
- `io.LimitReader` на всех читаемых телах апстрима (манифест 4МБ, blob 64МБ, файлы чарта 16МБ); контекст с таймаутом проброшен везде; HTTP-клиенты с `Timeout`.
- `events.Bus.Publish` неблокирующий (`default: drop`), unsubscribe под мьютексом - нет дедлока/утечки.
- FSM (`state_machine.go`): все переходы через `CanTransition`, недостижимых состояний нет, гонки версий гасятся optimistic locking + ретраем.
- ArgoCD `extractChartFiles` отбрасывает вложенные пути - traversal из tar нет.
- `middleware.Recoverer` подключён - паники хендлеров не роняют процесс.

---

## Приоритет исправлений (бэкенд)

1. Немедленно: C1 (plaintext-токены в Redis), C2 (обход allowlist чартов), H1 (паника/небезопасный Secure).
2. Далее: H2 (nonce), H3 (транзакции/аудит), H4 (проверка дайджеста), M14 (insecure TLS), M5-M8 (DoS-харднинг HTTP).
3. Затем: M1-M4 (управление сессиями, refresh, RBAC, CSRF logout), M9-M13 (SSRF/path/миграции/таймауты/аудит).
4. Хардннинг: блок Low.

---

# Фронтенд (web/, React 19 + TS + Vite SPA, ~10k строк)

Ревью покрыло безопасность (XSS/markdown/YAML/Monaco/токены/редиректы) и корректность (хуки, async-гонки, SSE, формы). По безопасности эксплуатируемых уязвимостей не найдено - код написан аккуратно. Основные находки - в корректности (баги форм и навигации).

## Безопасность - проверено, чисто

- **XSS через markdown** - чисто. Все три `ReactMarkdown` (`Markdown.tsx:44`, `DocsPage.tsx:278`, `AboutPage.tsx:106`) используют только remark-плагины; `rehype-raw` не установлен, react-markdown v10 по умолчанию не рендерит сырой HTML. README/changelog/values безопасны.
- **dangerouslySetInnerHTML / innerHTML / eval / new Function** - ни одного вхождения в `src`.
- **js-yaml** - версия `^4.1.0`; `yaml.load()` в v4 это и есть безопасный парсер (типы `!!js/function`/`!!js/eval` удалены, prototype pollution через `__proto__` закрыт). Code-exec невозможен.
- **Monaco** - настроен только темой/опциями отображения, произвольного исполнения нет.
- **Токены/креды** - `client.ts` использует `credentials: "include"` (cookie-сессия); токенов в коде/URL/логах нет; в localStorage только тема/команда/флаги «видел версию», без PII.
- **Открытый редирект** - `UserContext.tsx:32-33` строит `return_to` из относительного `pathname+search` (same-origin), кодирует через `encodeURIComponent`.

## Безопасность - Low (defense-in-depth, не эксплуатируется при текущей модели доверия)

- **FE-L1.** `href` из серверных данных без клиентской санитизации: `requestDetailParts.tsx:718` (`m.mr_url`), `RequestDetailPage.tsx:387` (`argocd_url`), `StatusPage.tsx:112` (`c.url`). React не блокирует `javascript:`-URL в проде. Источники сейчас доверенные (URL формирует бэкенд из конфига). Рекомендация: хелпер `safeHref`, пропускающий только `http(s):` (в `DocsPage.tsx:229` для markdown такая проверка уже есть - стоит унифицировать).
- **FE-L2.** `new RegExp(s.pattern)` из серверной JSON-схемы (`SchemaForm.tsx:53`) - теоретический ReDoS при кривом паттерне. Схемы проходят согласование, риск низкий. Рекомендация: `try/catch` + лимит длины ввода.
- **FE-L3.** `rel="noreferrer"` без явного `noopener` на `target="_blank"` (`Markdown.tsx:14`, `DocsPage.tsx:230`, `AboutPage.tsx:28`, `StatusPage.tsx:114`, `requestDetailParts.tsx:91,720`). Современные браузеры применяют `noopener` к `_blank` автоматически, и `noreferrer` его подразумевает - уже закрыто. Косметика: писать `rel="noopener noreferrer"`.

## Корректность

### High

- **FE-H1. `navigate()` в теле рендера** - `OrderPage.tsx:174`. Редирект `navigate(...)` вызывается прямо в render (не в `useEffect`), что в React 19/StrictMode даёт предупреждение «Cannot update a component while rendering» и потенциально двойную навигацию. Рекомендация: `return <Navigate to={...} replace />`.
- **FE-H2. Нет отмены запросов в `useAsync`** - `useAsync.ts:20-38` + `client.ts:59-83`. Флаг `alive` защищает от setState после unmount, но сам fetch не отменяется (нет `AbortController`). При часто меняющихся deps (OrderPage `[project, name, effectiveVersion]`) накапливаются висящие запросы к `/schema`, `/charts`, `/catalog`. Рекомендация: пробрасывать `AbortSignal` из `useAsync` в `fetch`, в cleanup вызывать `abort()`.

### Medium

- **FE-M1. `MapField` не ресинхронизируется с внешним `value`** - `SchemaForm.tsx:755-766`. `rows` инициализируется через `useState(init)` только при монтировании. При внешнем изменении `value` (переключение form/raw в OrderPage через `setValues(yaml.load(raw))`, гидратация черновика, upgrade-prefill) компонент показывает устаревшие ключи/значения. Рекомендация: сделать контролируемым (выводить rows из `value`) либо синхронизировать через `useEffect`/`key`.
- **FE-M2. `key={i}` (index) на изменяемых списках** - `GenericProductTabs.tsx:288` (ListEditor), `SchemaForm.tsx:600,643,773` (ArrayField/MapField). Списки add/remove/reorder; при удалении из середины React переиспользует DOM/состояние по индексу - раскрытое состояние `Disclosure`, фокус и значение инпутов «съезжают» на соседний элемент. Рекомендация: стабильный ключ по id/name элемента или внутренний uid.
- **FE-M3. `SingleField` seed-guard ломается при ресете формы** - `SchemaForm.tsx:713-723`. `seeded.current=true` навсегда после первого засева; при пересоздании values (смена режима/версии в upgrade, гидратация) повторный засев дефолтов не происходит, поле остаётся пустым. Пограничный баг при upgrade/смене версии.
- **FE-M4. `semver.parse` молча трактует невалидную версию как `0.0.0`** - `semver.ts:6-12`. `parseInt("abc")` -> NaN -> 0; `"latest"`/`"main"` парсятся как `0.0.0`. Pre-release (`-rc1`) полностью игнорируется, поэтому `1.2.3-rc1` == `1.2.3`, что даёт нестабильную сортировку при наличии rc. В боевом каталоге Harbor отдаёт semver (риск низкий), но импортированные из Git заказы могут иметь нестандартный `chart_version`.

### Low

- **FE-L4. Необработанный rejection в `onConfirmDelete`** - `RequestDetailPage.tsx:162-165`: `api.deleteRequest` без catch, при ошибке - висящий unhandled rejection. Плюс ошибки показываются через нативный `alert()` (`RequestDetailPage.tsx:181,191,199,209`, `OrdersTable.tsx:127`) вместо существующего `ToastProvider` - неконсистентно и блокирует UI.
- **FE-L5. Нет таймаута на fetch** - `client.ts:59-83`: зависший бэкенд/прокси оставит запрос висеть бесконечно, спиннер не снимется. Рекомендация: `AbortSignal.timeout()` по умолчанию.
- **FE-L6. `ToastProvider` не чистит таймеры авто-дисмисса** - `ToastContext.tsx:47`: `setTimeout` не сохраняется/не очищается; при ручном dismiss таймер всё равно сработает позже (безвредно, но лишний). Провайдер корневой, риск минимальный.
- **FE-L7. SSE без `onerror`-наблюдаемости** - `OrdersTable.tsx:71-76`, `RequestDetailPage.tsx:72-81`: cleanup (`es.close()`) на месте, утечек соединений нет, браузер реконнектит сам; но нет логирования длительных разрывов.

## Корректность - проверено, чисто

- SSE-эффекты в `RequestDetailPage`/`OrdersTable`/`ApplicationsPage`: cleanup с `es.close()`/`removeEventListener` присутствует - утечек соединений нет.
- `TeamContext`/`CatalogContext`/`ThemeContext`: persisted state читается через try/catch, утечек нет.
- `ApplicationsPage`: пустые данные обработаны (`data ?? []`), стабильные ключи `key={a.name}`.
- `OrdersTable.rows`: `useMemo` deps корректны, `key={r.id}` стабилен.

## Приоритет исправлений (фронтенд)

1. FE-H1 (navigate в рендере - быстрый фикс через `<Navigate>`), FE-M1 + FE-M2 (баги форм с потерей состояния).
2. FE-H2 (отмена запросов), FE-M3 (seed при upgrade), FE-L4 (unhandled rejection).
3. Остальное (FE-L*, FE-M4) - хардннинг/UX.
