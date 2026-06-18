# Reset the demo state WITHOUT recreating the stand: wipes the portal store
# (Postgres), the cache (Redis), the Argo CD applications, and the GitLab repos
# the portal created - so the next bring-up starts from a clean slate.
#
# Explicitly does NOT touch:
#   - Harbor (the chart registry) - charts stay published.
#   - The KinD cluster / Argo CD install itself - only the Applications go.
#   - The GitLab groups (managed-services + team-* subgroups) and the portal
#     token from the seed - only the project repos under them are deleted.
#
# Requires: the compose Postgres/Redis running (`make up-upstreams`), the KinD
# stand up (`make stand-up`), and GitLab reachable. Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File scripts/reset-state.ps1 -Yes
param(
    [string]$GitlabUrl   = "http://localhost:8929",
    [string]$GitlabToken = "glpat-localdev0123456789abcd",
    [string]$ArgoNamespace = "argocd",
    [switch]$Yes
)
$ErrorActionPreference = "Stop"
# Repo root = two levels up (deployments/scripts/ -> deployments/ -> repo).
$root    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$compose = Join-Path $root "deployments\docker-compose.yml"

if (-not $Yes) {
    Write-Host "This will DELETE:" -ForegroundColor Yellow
    Write-Host "  - all rows in Postgres (requests, request_mrs, request_events)"
    Write-Host "  - all keys in Redis (FLUSHALL)"
    Write-Host "  - all Argo CD Applications in ns '$ArgoNamespace' (+ their deployed resources)"
    Write-Host "  - all GitLab project repos under group 'managed-services'"
    Write-Host "Harbor and the KinD cluster are left intact." -ForegroundColor Green
    Write-Host ""
    Write-Host "Re-run with -Yes to proceed." -ForegroundColor Yellow
    exit 1
}

# --- 1. GitLab: delete the portal-created repos (keep groups + token) ----------
# The portal commits services as projects under managed-services/<team>/<chart>;
# the seed only ever creates the groups, so deleting every project under the top
# group (incl. subgroups) returns GitLab to its seeded baseline.
Write-Host "[reset] GitLab: listing projects under managed-services..." -ForegroundColor Cyan
$B = "$GitlabUrl/api/v4"
$listJson = curl.exe -s -H "PRIVATE-TOKEN: $GitlabToken" `
    "$B/groups/managed-services/projects?include_subgroups=true&per_page=100&simple=true"
$ids = @()
try { $ids = @(($listJson | ConvertFrom-Json) | ForEach-Object { $_.id }) } catch {}
if (-not $ids) {
    Write-Host "[reset] GitLab: no projects to delete (or group absent)." -ForegroundColor DarkGray
} else {
    foreach ($id in $ids) {
        $code = (curl.exe -s -o NUL -w "%{http_code}" -X DELETE -H "PRIVATE-TOKEN: $GitlabToken" "$B/projects/$id")
        Write-Host "[reset]   deleted project id=$id (HTTP $code)"
    }
}

# --- 2. Argo CD: drop the bootstrap ApplicationSet + every Application ----------
# Deleting the ApplicationSet first stops it from regenerating directory-apps for
# repos that (briefly) still appear in the SCM cache; then we delete all
# Applications (their resources-finalizer cascade-prunes deployed workloads), and
# finally re-apply the AppProject + ApplicationSet so future orders work again.
Write-Host "[reset] Argo CD: removing ApplicationSet + Applications..." -ForegroundColor Cyan
kubectl -n $ArgoNamespace delete applicationset portal-app-of-apps --ignore-not-found | Out-Host
kubectl -n $ArgoNamespace delete applications --all --timeout=120s | Out-Host
Write-Host "[reset] Argo CD: re-applying AppProject + ApplicationSet..."
kubectl apply -f (Join-Path $root "deployments\kind\appproject.yaml") | Out-Host
kubectl apply -f (Join-Path $root "deployments\kind\applicationset.yaml") | Out-Host

# --- 3. Postgres: truncate the portal store ------------------------------------
Write-Host "[reset] Postgres: truncating requests/request_mrs/request_events..." -ForegroundColor Cyan
docker compose -f $compose exec -T postgres `
    psql -U portal -d portal -c "TRUNCATE requests, request_mrs, request_events RESTART IDENTITY CASCADE;" | Out-Host
if ($LASTEXITCODE -ne 0) { Write-Host "[reset] WARN: psql truncate failed (is the postgres container up?)" -ForegroundColor Yellow }

# --- 4. Valkey: flush the cache ------------------------------------------------
Write-Host "[reset] Valkey: FLUSHALL..." -ForegroundColor Cyan
docker compose -f $compose exec -T valkey valkey-cli FLUSHALL | Out-Host
if ($LASTEXITCODE -ne 0) { Write-Host "[reset] WARN: valkey FLUSHALL failed (is the valkey container up?)" -ForegroundColor Yellow }

Write-Host ""
Write-Host "[reset] done. Postgres/Redis/Argo/GitLab cleared; Harbor untouched." -ForegroundColor Green
Write-Host "[reset] Restart the portal if anything looks stale (it re-reads the empty store)." -ForegroundColor DarkGray
