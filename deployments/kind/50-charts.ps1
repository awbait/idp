# Seed the stand's Harbor with Helm charts from an EXTERNAL directory.
#
# This repo is chart-agnostic: it does not vendor deployable charts. The charts
# (ingress-gateway, egress, …) live in their own location/repo and are published
# to Harbor by their own pipeline. For a local stand you can point this script at
# that directory to push them once; at runtime the portal + ArgoCD only consume
# whatever is in Harbor.
#
# Source: -ChartsDir <path>, or $env:STAND_CHARTS_DIR. The directory holds one
# subfolder per chart (each with a Chart.yaml). All are pushed to the Harbor
# project below. If no source is configured the step is skipped (non-fatal) —
# populate Harbor separately.
param(
    [string]$ChartsDir = $env:STAND_CHARTS_DIR,
    [string]$HarborHost = "host.docker.internal:8084",
    [string]$Project = "platform",
    [string]$HarborUser = "admin",
    [string]$HarborPass = "Harbor12345"
)
$ErrorActionPreference = "Stop"

if (-not $ChartsDir -or -not (Test-Path $ChartsDir)) {
    Write-Host "[charts] no chart source (set -ChartsDir or `$env:STAND_CHARTS_DIR) — skipping." -ForegroundColor DarkYellow
    Write-Host "[charts] Harbor must be populated separately; the portal/Argo read whatever is in Harbor."
    exit 0
}

$chartDirs = Get-ChildItem -Path $ChartsDir -Directory | Where-Object { Test-Path (Join-Path $_.FullName "Chart.yaml") }
if (-not $chartDirs) {
    Write-Host "[charts] no chart subfolders (with Chart.yaml) under $ChartsDir — nothing to push." -ForegroundColor DarkYellow
    exit 0
}

# Harbor's OCI registry requires auth for push (anonymous pull on the public project).
helm registry login $HarborHost -u $HarborUser -p $HarborPass --insecure | Out-Host
if ($LASTEXITCODE -ne 0) { throw "helm registry login to Harbor failed" }

foreach ($dir in $chartDirs) {
    $chartDir = $dir.FullName
    $verLine = Select-String -Path (Join-Path $chartDir "Chart.yaml") -Pattern '^version:\s*(.+)$' | Select-Object -First 1
    $nameLine = Select-String -Path (Join-Path $chartDir "Chart.yaml") -Pattern '^name:\s*(.+)$' | Select-Object -First 1
    if (-not $verLine -or -not $nameLine) { Write-Host "[charts] $($dir.Name): no name/version in Chart.yaml — skip" -ForegroundColor DarkYellow; continue }
    $ver = $verLine.Matches[0].Groups[1].Value.Trim()
    $name = $nameLine.Matches[0].Groups[1].Value.Trim()
    Write-Host "[charts] $name version $ver"

    $out = $env:TEMP
    helm package $chartDir --destination $out | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "helm package failed for $name" }
    $tgz = Join-Path $out "$name-$ver.tgz"

    # Clear any pre-existing repository first. If a prior Harbor pod roll wiped the
    # registry's emptyDir but left the artifact row in the DB, re-pushing the same
    # digest 500s ("unexpected EOF"); deleting the repo drops that stale metadata.
    $delCode = (curl.exe -sk -o NUL -w "%{http_code}" -u "${HarborUser}:${HarborPass}" `
        -X DELETE "https://$HarborHost/api/v2.0/projects/$Project/repositories/$name")
    Write-Host "[charts] cleared existing repo $Project/$name (HTTP $delCode)"

    # Retry: Harbor may briefly not serve right after the release becomes ready.
    $pushed = $false
    for ($i = 1; $i -le 4; $i++) {
        helm push $tgz "oci://$HarborHost/$Project" --insecure-skip-tls-verify | Out-Host
        if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
        Write-Host "[charts] push attempt $i failed; retrying in 4s..."
        Start-Sleep -Seconds 4
    }
    if (-not $pushed) { throw "helm push failed for $name (Harbor reachable on $HarborHost?)" }
    Remove-Item $tgz -ErrorAction SilentlyContinue
    Write-Host "[charts] pushed oci://$HarborHost/$Project/${name}:$ver" -ForegroundColor Green
}
