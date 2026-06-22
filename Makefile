.PHONY: build run-oidc web infra obs test vet lint tidy cover hooks down docker \
	up-upstreams-infra down-upstreams gitlab-seed \
	stand-up stand-down stand-charts stand-appset stand-token stand-reset seed-import

# Version/commit/date stamped into the binary for the "About" page. `go run`
# does not apply VCS stamping, so inject via ldflags (best-effort: empty when
# git/date is unavailable, then buildinfo falls back to any VCS info present).
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)
GO_LDFLAGS := -X console/internal/buildinfo.Version=$(VERSION) -X console/internal/buildinfo.Commit=$(COMMIT) -X console/internal/buildinfo.Date=$(DATE)

build:
	go build ./...

# === Local dev loop: infra in Docker, portal + web from source (live reload) ===
# Typical: `make infra` once, then `make run-oidc` and `make web` in separate
# terminals. Open http://localhost:5173 and log in via Keycloak.

# Infra only: Postgres + Valkey + Keycloak. The portal and SPA run from source
# (targets below) so backend/frontend changes hot-reload.
infra:
	docker compose -f deployments/docker-compose.yml up -d postgres valkey keycloak

# Observability: Prometheus (scrapes the portal's /metrics) + Grafana with the
# IDP dashboard auto-provisioned. Works with the host-run portal (`make run-oidc`).
# Prometheus on http://localhost:9090, Grafana on http://localhost:3000.
obs:
	docker compose -f deployments/docker-compose.yml up -d prometheus grafana

# Backend against the compose infra with real Keycloak login (run `make infra`
# first). Postgres + Valkey so orders/sessions persist across restarts. Browser
# and portal share issuer http://localhost:8081/realms/internal.
# Log in as alice/alice (team-core) or padmin/padmin (platform-admins).
run-oidc:
	HARBOR_MODE=fake GITLAB_MODE=fake ARGOCD_MODE=fake \
	STORE=postgres CACHE=redis \
	DATABASE_URL=postgres://portal:portal@localhost:5432/portal?sslmode=disable \
	REDIS_URL=redis://localhost:6379/0 \
	AUTH_MODE=oidc \
	SESSION_SECRET=dev-local-session-key-not-for-production \
	COOKIE_SECURE=false \
	OIDC_ISSUER=http://localhost:8081/realms/internal \
	OIDC_CLIENT_ID=portal \
	OIDC_CLIENT_SECRET=portal-secret \
	OIDC_REDIRECT_URL=http://localhost:5173/api/v1/auth/callback \
	OIDC_POST_LOGIN_REDIRECT=http://localhost:5173/ \
	OIDC_POST_LOGOUT_REDIRECT=http://localhost:5173/ \
	OIDC_SCOPES=openid,profile,email \
	RBAC_ADMIN_GROUPS=platform-admins \
	RBAC_SUPPORT_GROUPS=support \
	RBAC_SECURITY_GROUPS=security \
	go run -ldflags "$(GO_LDFLAGS)" ./cmd/portal

# Frontend dev server (Vite) on :5173 with live reload; proxies /api -> :8080.
# --host binds all interfaces (incl. IPv4); without it Vite is IPv6-only, which
# breaks clients that resolve localhost to 127.0.0.1.
web:
	cd web && bun install && bun run dev --host

test:
	go test ./...

vet:
	go vet ./...

# Lint both Go modules (same as the lefthook pre-push gate).
lint:
	golangci-lint run ./...
	cd collector && golangci-lint run ./...

# Install git hooks (lefthook). Run once after clone.
hooks:
	lefthook install

tidy:
	go mod tidy

cover:
	go test -cover ./internal/...

# Tear down the infra stack and its volumes (also removes `make infra` data).
down:
	docker compose -f deployments/docker-compose.yml down -v

# Real-upstreams backing services: a real GitLab CE + the KinD stand's Argo
# CD/Harbor. Bring the stand up first (`make stand-up`); it writes ARGOCD_TOKEN
# into deployments/.env automatically. After GitLab is healthy, run
# `make gitlab-seed` once (GitLab boots for minutes; watch with `docker compose ps`).
# This starts only the backing services (GitLab + Postgres + Valkey + Keycloak);
# run the portal on the host with OIDC via
# `deployments/scripts/run-oidc.ps1 -RealGitlab`, plus `make web`. SPA on :5173.
up-upstreams-infra:
	docker compose --env-file deployments/.env -f deployments/docker-compose.yml -f deployments/docker-compose.upstreams.yml up -d postgres valkey keycloak gitlab

down-upstreams:
	docker compose -f deployments/docker-compose.yml -f deployments/docker-compose.upstreams.yml down -v

# Seed GitOps groups + the fixed portal API token into the running GitLab.
gitlab-seed:
	docker compose -f deployments/docker-compose.yml -f deployments/docker-compose.upstreams.yml exec -T gitlab gitlab-rails runner /seed.rb

# .dockerignore excludes .git, so the toolchain can't VCS-stamp inside the build;
# pass version/commit/date (resolved from the host's git) as build args instead.
# Release pipelines should likewise pass --build-arg VERSION=<tag>.
docker:
	docker build \
		--build-arg VERSION=$(VERSION) \
		--build-arg COMMIT=$(COMMIT) \
		--build-arg DATE=$(DATE) \
		-t console:dev .

# --- Local e2e stand: KinD + Argo CD + Harbor (Windows/PowerShell) ---
# Full bring-up; writes ARGOCD_TOKEN into deployments/.env at the end, then run
# `make up-upstreams` + `make gitlab-seed`. See deployments/kind/README.md.
stand-up:
	powershell -ExecutionPolicy Bypass -File deployments/kind/up.ps1

stand-down:
	powershell -ExecutionPolicy Bypass -File deployments/kind/down.ps1

# Push charts from an external dir to Harbor (set STAND_CHARTS_DIR; see the script).
stand-charts:
	powershell -ExecutionPolicy Bypass -File deployments/kind/50-charts.ps1

# Re-apply the bootstrap ApplicationSet.
stand-appset:
	powershell -ExecutionPolicy Bypass -File deployments/kind/70-appset.ps1

# Print the Argo CD admin password + mint a fresh ARGOCD_TOKEN.
stand-token:
	powershell -ExecutionPolicy Bypass -File deployments/kind/token.ps1

# Reset demo state WITHOUT rebuilding the stand: wipes Postgres + Valkey + Argo CD
# Applications + the portal's GitLab repos. Harbor (charts) and the KinD cluster
# are left intact. Destructive - pass -Yes (see deployments/scripts/reset-state.ps1).
stand-reset:
	powershell -ExecutionPolicy Bypass -File deployments/scripts/reset-state.ps1 -Yes

# Seed an ingress-gateway instance straight into Git (bypassing the portal) to
# exercise import/discovery. Needs IMPORT_DISCOVERY_ENABLED=true on the portal.
seed-import:
	powershell -ExecutionPolicy Bypass -File deployments/scripts/seed-import.ps1
