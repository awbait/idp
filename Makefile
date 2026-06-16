.PHONY: build run test vet lint tidy cover hooks up down docker \
	stand-up stand-down stand-charts stand-appset stand-token stand-reset seed-import

build:
	go build ./...

# Run locally with all fakes + in-memory store/cache (no Docker, no upstreams).
# Modes are set explicitly because the real upstreams are now the default.
run:
	HARBOR_MODE=fake GITLAB_MODE=fake ARGOCD_MODE=fake \
	go run ./cmd/portal

# Run on host against Keycloak from docker-compose (start it first: `make up`).
# Browser and portal share issuer http://localhost:8081/realms/internal.
# Log in as alice/alice (team-core) or padmin/padmin (platform-admins).
run-oidc:
	HARBOR_MODE=fake GITLAB_MODE=fake ARGOCD_MODE=fake \
	AUTH_MODE=oidc \
	OIDC_ISSUER=http://localhost:8081/realms/internal \
	OIDC_CLIENT_ID=portal \
	OIDC_CLIENT_SECRET=portal-secret \
	OIDC_REDIRECT_URL=http://localhost:8080/api/v1/auth/callback \
	OIDC_POST_LOGIN_REDIRECT=http://localhost:5173/ \
	OIDC_SCOPES=openid,profile,email \
	RBAC_ADMIN_GROUPS=platform-admins \
	go run ./cmd/portal

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

# Full local stack (Postgres + Redis + portal) via docker-compose.
up:
	docker compose -f deployments/docker-compose.yml up --build

down:
	docker compose -f deployments/docker-compose.yml down -v

# Same stack but with a real GitLab CE + real Argo CD (the KinD stand).
# Bring the stand up first (`make stand-up`) and put ARGOCD_TOKEN in
# deployments/.env. After GitLab is healthy, run `make gitlab-seed` once.
# Detached (GitLab boots for minutes): watch with `docker compose ps` / logs.
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
# Full bring-up; prints ARGOCD_TOKEN at the end. Put it in deployments/.env,
# then `make up-upstreams` + `make gitlab-seed`. See deployments/kind/README.md.
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
# are left intact. Destructive — pass -Yes (see deployments/scripts/reset-state.ps1).
stand-reset:
	powershell -ExecutionPolicy Bypass -File deployments/scripts/reset-state.ps1 -Yes

# Seed an ingress-gateway instance straight into Git (bypassing the portal) to
# exercise import/discovery. Needs IMPORT_DISCOVERY_ENABLED=true on the portal.
seed-import:
	powershell -ExecutionPolicy Bypass -File deployments/scripts/seed-import.ps1
