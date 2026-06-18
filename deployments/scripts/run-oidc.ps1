# Runs the portal in OIDC mode on :8080 for local Keycloak testing.
# Frees :8080 (stops the compose dev-portal) and ensures Keycloak is up first,
# then runs the portal in the foreground. Stop with Ctrl+C.
#
# -BindHost is the hostname the BROWSER uses to reach Keycloak/portal/SPA.
# Use "localhost" when browsing on this machine, or a LAN IP (e.g. 10.10.100.33)
# when opening the SPA via that address. The same host must be allowed in the
# realm's redirectUris/webOrigins (see deployments/keycloak/realm-internal.json).
#
# -RealGitlab points the portal at the real GitLab CE + the compose Postgres/Redis
# (from `make up-upstreams`) instead of the in-memory fakes. Requires that stack
# up and seeded (`make gitlab-seed`).
#
# Usage:  .\deployments\scripts\run-oidc.ps1                       # localhost, fakes + memory
#         .\deployments\scripts\run-oidc.ps1 -BindHost 10.10.100.33
#         .\deployments\scripts\run-oidc.ps1 -BindHost 10.10.100.33 -RealGitlab
# If script execution is blocked:
#   powershell -ExecutionPolicy Bypass -File .\deployments\scripts\run-oidc.ps1 -BindHost 10.10.100.33
param([string]$BindHost = "localhost", [switch]$RealGitlab)
$ErrorActionPreference = "Stop"
# Repo root = two levels up (deployments/scripts/ -> deployments/ -> repo).
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# Free :8080 and make sure Keycloak is running.
Push-Location (Join-Path $root "deployments")
try {
  docker compose stop portal | Out-Null
  docker compose up -d keycloak | Out-Null
} finally {
  Pop-Location
}

$env:AUTH_MODE = "oidc"
$env:OIDC_ISSUER = "http://${BindHost}:8081/realms/internal"
$env:OIDC_CLIENT_ID = "portal"
$env:OIDC_CLIENT_SECRET = "portal-secret"
$env:OIDC_REDIRECT_URL = "http://${BindHost}:8080/api/v1/auth/callback"
$env:OIDC_POST_LOGIN_REDIRECT = "http://${BindHost}:5173/"
$env:OIDC_POST_LOGOUT_REDIRECT = "http://${BindHost}:5173/"
$env:OIDC_SCOPES = "openid,profile,email"
$env:RBAC_ADMIN_GROUPS = "platform-admins"
$env:RBAC_SUPPORT_GROUPS = "support"
$env:RBAC_SECURITY_GROUPS = "security"

if ($RealGitlab) {
  # Real GitLab CE + compose Postgres/Redis (ports exposed on the host).
  $env:GITLAB_MODE         = "real"
  $env:GITLAB_URL          = "http://localhost:8929"
  $env:GITLAB_TOKEN        = "glpat-localdev0123456789abcd"
  $env:GITLAB_AUTO_MERGE   = "true"   # poller merges portal MRs itself (no human gate)
  $env:STATUS_POLL_INTERVAL = "5s"    # snappier status progression for the demo
  # Reverse sync against real Git (only meaningful with GITLAB_MODE=real):
  #  - drift: flag orders edited directly in Git (read-only). Default true anyway;
  #    set explicit so it's easy to flip off here.
  #  - import: adopt application.yaml created in Git outside the portal. Off by
  #    default (creates order rows); flip to "true" to demo it.
  $env:DRIFT_DETECTION_ENABLED  = "true"
  $env:IMPORT_DISCOVERY_ENABLED = "true"
  # Real Harbor from the KinD stand (NodePort on host port 8084, self-signed TLS).
  # The host-run portal reads the catalog here via the published port (localhost,
  # like GITLAB_URL/ARGOCD_URL above). Only the `platform` project holds charts on
  # the stand - listing the absent `managed-services` project would 401 anonymously.
  $env:HARBOR_MODE         = "real"
  $env:HARBOR_URL          = "https://localhost:8084"
  $env:HARBOR_INSECURE_TLS = "true"
  $env:HARBOR_PROJECTS     = "platform"
  # OCI registry base baked into the committed application.yaml chart source (Argo
  # pulls the chart from Harbor; values come from git). MUST stay host.docker.internal
  # - that's the name Argo pods resolve inside KinD (via CoreDNS), not localhost.
  $env:CHART_REGISTRY = "host.docker.internal:8084"
  $env:STORE        = "postgres"
  $env:DATABASE_URL = "postgres://portal:portal@localhost:5432/portal?sslmode=disable"
  $env:CACHE        = "redis"
  $env:REDIS_URL    = "redis://localhost:6379/0"
  Write-Host "Upstreams: REAL GitLab (http://localhost:8929) + Postgres/Redis" -ForegroundColor Yellow

  # Real Argo CD from the local KinD stand (scripts/stand). The KinD node
  # publishes argocd-server on host port 8083. Token comes from deployments/.env
  # (printed by `make stand-up`). Without a token, fall back to the fake Argo
  # (orders still progress, but the real cluster is not used).
  if (-not $env:ARGOCD_TOKEN) {
    $envFile = Join-Path $root "deployments\.env"
    if (Test-Path $envFile) {
      $m = Select-String -Path $envFile -Pattern '^\s*ARGOCD_TOKEN\s*=\s*(.+)$' | Select-Object -First 1
      if ($m) { $env:ARGOCD_TOKEN = $m.Matches[0].Groups[1].Value.Trim() }
    }
  }
  if ($env:ARGOCD_TOKEN) {
    $env:ARGOCD_MODE    = "real"
    $env:ARGOCD_URL     = "http://localhost:8083"
    $env:ARGOCD_PROJECT = "portal-managed"
    Write-Host "ArgoCD: REAL (http://localhost:8083, token from deployments/.env)" -ForegroundColor Yellow
  } else {
    Write-Host "ArgoCD: FAKE (no ARGOCD_TOKEN - run 'make stand-up' and put the token in deployments/.env for the real cluster)" -ForegroundColor DarkYellow
  }
} else {
  # Real upstreams are the default now, so opt into fakes explicitly here.
  $env:HARBOR_MODE = "fake"
  $env:GITLAB_MODE = "fake"
  $env:ARGOCD_MODE = "fake"
  $env:STORE = "memory"
  $env:CACHE = "memory"
  # Clear real-only vars that may linger from a prior -RealGitlab run in THIS
  # PowerShell session (env persists per-session) - otherwise the portal would
  # mix fake modes with a real DB/URLs.
  foreach ($v in "HARBOR_URL", "HARBOR_PROJECTS", "HARBOR_INSECURE_TLS",
                 "GITLAB_URL", "GITLAB_TOKEN", "GITLAB_AUTO_MERGE",
                 "ARGOCD_MODE", "ARGOCD_URL", "ARGOCD_TOKEN", "ARGOCD_PROJECT",
                 "CHART_REGISTRY", "DATABASE_URL", "REDIS_URL",
                 "DRIFT_DETECTION_ENABLED", "IMPORT_DISCOVERY_ENABLED") {
    Remove-Item "Env:$v" -ErrorAction SilentlyContinue
  }
  $env:HARBOR_MODE = "fake"; $env:GITLAB_MODE = "fake"; $env:ARGOCD_MODE = "fake"
  Write-Host "Upstreams: fakes + in-memory store (pass -RealGitlab for the real stack)" -ForegroundColor DarkGray
}

Write-Host "Portal -> OIDC mode on :8080 (Keycloak http://${BindHost}:8081). Open the SPA at http://${BindHost}:5173" -ForegroundColor Green

Push-Location $root
try {
  go run ./cmd/portal
} finally {
  Pop-Location
}
