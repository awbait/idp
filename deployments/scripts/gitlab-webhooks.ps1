# Registers the GitLab -> portal merge-request webhook on every order repo of the
# stand, so STATUS_UPDATE_MODE=hybrid/webhook reacts to a merge at once instead of
# on the next poll.
#
# Why per-project (not one group hook): GitLab CE has no group-level webhooks
# (Premium only), so we add a project webhook to each repo under the GitOps group.
# Repos are created by the portal per (team, chart), so RERUN this after ordering a
# new service to cover the freshly created repo. Idempotent: updates the hook in
# place if it already points at the same URL.
#
# GitLab also blocks webhooks to private addresses by default; this enables
# "allow requests to the local network from webhooks" (admin) so host.docker.internal
# is reachable.
#
# Usage:  .\deployments\scripts\gitlab-webhooks.ps1
#         .\deployments\scripts\gitlab-webhooks.ps1 -Secret my-secret -PortalUrl http://host.docker.internal:8080
# Run from the repo root. Stand defaults match deployments/scripts/run-oidc.ps1.
param(
  [string]$GitLabApi = "http://localhost:8929/api/v4",
  [string]$Token     = "glpat-localdev0123456789abcd",
  [string]$Group     = "managed-services",
  [string]$Secret    = "stand-gl-webhook-secret",
  # The URL GitLab POSTs to. GitLab connects from its container, where the portal
  # is reachable as host.docker.internal:8080 (NOT localhost - that is the GitLab
  # container itself).
  [string]$PortalUrl = "http://host.docker.internal:8080"
)
$ErrorActionPreference = "Stop"
$H = @{ "PRIVATE-TOKEN" = $Token }
$hookUrl = "$PortalUrl/api/v1/webhooks/gitlab"

# 1) Allow webhooks to the local network (else host.docker.internal is blocked).
$s = Invoke-RestMethod -Method Put -Headers $H -TimeoutSec 15 `
  -Uri "$GitLabApi/application/settings?allow_local_requests_from_web_hooks_and_services=true"
Write-Host "allow_local_requests_from_web_hooks = $($s.allow_local_requests_from_web_hooks_and_services)" -ForegroundColor Green

# 2) Resolve the group and its repos (including subgroups).
$g = Invoke-RestMethod -Headers $H -TimeoutSec 15 -Uri "$GitLabApi/groups/$([uri]::EscapeDataString($Group))"
$projs = Invoke-RestMethod -Headers $H -TimeoutSec 30 `
  -Uri "$GitLabApi/groups/$($g.id)/projects?include_subgroups=true&per_page=100"
if (-not $projs) { Write-Host "no repos under '$Group' yet - order a service first, then rerun" -ForegroundColor Yellow; return }

# 3) Create or update the merge-request webhook on each repo.
$body = @{
  url = $hookUrl; token = $Secret
  merge_requests_events = $true; push_events = $false
  enable_ssl_verification = $false   # portal is plain HTTP on the stand
} | ConvertTo-Json
foreach ($p in $projs) {
  $existing = Invoke-RestMethod -Headers $H -TimeoutSec 15 -Uri "$GitLabApi/projects/$($p.id)/hooks"
  $match = $existing | Where-Object { $_.url -eq $hookUrl } | Select-Object -First 1
  if ($match) {
    Invoke-RestMethod -Method Put -Headers $H -Body $body -ContentType "application/json" -TimeoutSec 15 `
      -Uri "$GitLabApi/projects/$($p.id)/hooks/$($match.id)" | Out-Null
    Write-Host "updated $($p.path_with_namespace) (hook $($match.id))" -ForegroundColor DarkGray
  } else {
    $new = Invoke-RestMethod -Method Post -Headers $H -Body $body -ContentType "application/json" -TimeoutSec 15 `
      -Uri "$GitLabApi/projects/$($p.id)/hooks"
    Write-Host "created $($p.path_with_namespace) (hook $($new.id)) -> $hookUrl" -ForegroundColor Green
  }
}
Write-Host "done. Restart the portal with GITLAB_WEBHOOK_TOKEN=$Secret (run-oidc.ps1 sets it for -RealGitlab)." -ForegroundColor Cyan
