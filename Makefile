.PHONY: build run run-oidc web infra obs test vet lint tidy cover hooks up down docker \
	up-upstreams down-upstreams gitlab-seed \
	stand-up stand-down stand-charts stand-appset stand-token stand-reset seed-import

build:
	go build ./...

# === Local dev loop: infra in Docker, portal + web from source (live reload) ===
# Typical: `make infra` once, then `make run` (or `make run-oidc`) and `make web`
# in separate terminals. Open http://localhost:5173.

# Infra only: Postgres + Redis + Keycloak. The portal and SPA run from source
# (targets below) so backend/frontend changes hot-reload.
infra:
	docker compose -f deployments/docker-compose.yml up -d postgres redis keycloak

# Observability: Prometheus (scrapes the portal's /metrics) + Grafana with the
# IDP dashboard auto-provisioned. Works with the host-run portal (`make run`).
# Prometheus on http://localhost:9090, Grafana on http://localhost:3000.
obs:
	docker compose -f deployments/docker-compose.yml up -d prometheus grafana

# Backend, zero-infra: in-memory store/cache, fake upstreams, dev-auth (no
# Keycloak needed). Fastest inner loop; state is lost on restart. Pair with `make web`.
run:
	HARBOR_MODE=fake GITLAB_MODE=fake ARGOCD_MODE=fake \
	go run ./cmd/portal

# Backend against the compose infra with real Keycloak login (run `make infra`
# first). Postgres + Redis so orders/sessions persist across restarts. Browser
# and portal share issuer http://localhost:8081/realms/internal.
# Log in as alice/alice (team-core) or padmin/padmin (platform-admins).
run-oidc:
	HARBOR_MODE=fake GITLAB_MODE=fake ARGOCD_MODE=fake \
	STORE=postgres CACHE=redis \
	DATABASE_URL=postgres://portal:portal@localhost:5432/portal?sslmode=disable \
	REDIS_URL=redis://localhost:6379/0 \
	AUTH_MODE=oidc \
	OIDC_ISSUER=http://localhost:8081/realms/internal \
	OIDC_CLIENT_ID=portal \
	OIDC_CLIENT_SECRET=portal-secret \
	OIDC_REDIRECT_URL=http://localhost:8080/api/v1/auth/callback \
	OIDC_POST_LOGIN_REDIRECT=http://localhost:5173/ \
	OIDC_POST_LOGOUT_REDIRECT=http://localhost:5173/ \
	OIDC_SCOPES=openid,profile,email \
	RBAC_ADMIN_GROUPS=platform-admins \
	go run ./cmd/portal

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

# Full containerized stack: infra + portal + web all in Docker (fake upstreams,
# dev-auth). For a no-source run/demo; for development prefer the dev loop above
# (make infra + run + web). SPA on http://localhost:8088.
up:
	docker compose -f deployments/docker-compose.yml up --build

# Tear down the stack and its volumes (also removes `make infra` containers/data).
down:
	docker compose -f deployments/docker-compose.yml down -v

# Same stack but with a real GitLab CE + real Argo CD (the KinD stand).
# Bring the stand up first (`make stand-up`); it writes ARGOCD_TOKEN into
# deployments/.env automatically. After GitLab is healthy, run `make gitlab-seed`
# once. Detached (GitLab boots for minutes): watch with `docker compose ps` / logs.
up-upstreams:
	docker compose --env-file deployments/.env -f deployments/docker-compose.yml -f deployments/docker-compose.upstreams.yml up --build -d

down-upstreams:
	docker compose -f deployments/docker-compose.yml -f deployments/docker-compose.upstreams.yml down -v

# Seed GitOps groups + the fixed portal API token into the running GitLab.
gitlab-seed:
	docker compose -f deployments/docker-compose.yml -f deployments/docker-compose.upstreams.yml exec -T gitlab gitlab-rails runner /seed.rb

docker:
	docker build -t idp-portal:dev .

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

# Reset demo state WITHOUT rebuilding the stand: wipes Postgres + Redis + Argo CD
# Applications + the portal's GitLab repos. Harbor (charts) and the KinD cluster
# are left intact. Destructive - pass -Yes (see deployments/scripts/reset-state.ps1).
stand-reset:
	powershell -ExecutionPolicy Bypass -File deployments/scripts/reset-state.ps1 -Yes

# Seed an ingress-gateway instance straight into Git (bypassing the portal) to
# exercise import/discovery. Needs IMPORT_DISCOVERY_ENABLED=true on the portal.
seed-import:
	powershell -ExecutionPolicy Bypass -File deployments/scripts/seed-import.ps1
