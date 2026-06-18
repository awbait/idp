# Create the public Harbor project that holds the platform charts (idempotent).
# Public => anonymous pull (Argo) and anonymous API read (portal catalog), so no
# robot credentials are needed anywhere on the stand. Push still uses admin.
param([string]$Project = "platform")
$ErrorActionPreference = "Stop"

# Use the loopback host-side (not host.docker.internal, which may not resolve from
# the host shell). This is Harbor's core API with HTTP Basic auth - it does not go
# through the OCI token realm - so 127.0.0.1 works; -k skips the self-signed cert.
$base = "https://127.0.0.1:8084/api/v2.0"
# metadata.public as a string is Harbor's canonical form across 2.x. Write the
# JSON to a temp file and feed curl via -d "@file": passing a quoted body inline
# is mangled by PowerShell's native-argument quoting (5.1 strips the inner double
# quotes), so Harbor receives invalid JSON and answers 422. The file path goes
# through verbatim regardless of the host's PowerShell version.
$bodyFile = New-TemporaryFile
Set-Content -Path $bodyFile -Value "{`"project_name`":`"$Project`",`"metadata`":{`"public`":`"true`"}}" -Encoding ascii -NoNewline

# Harbor's /health flips to 200 a good minute before the project API can accept
# writes - right after a (re)install the core rolls and POST returns a transient
# 422/5xx until it's truly ready. So: each round first GET the project (reads come
# up earlier than writes - this makes idempotent re-runs succeed instantly), and
# only POST when it's absent. A freshly installed core can take several minutes
# before it accepts project writes (422 until then) - longer on a loaded host - so
# retry generously (~600s).
$done = $false
for ($i = 1; $i -le 120; $i++) {
    $existing = (curl.exe -sk -u "admin:Harbor12345" "$base/projects?name=$Project")
    if ($existing -match "`"name`":`"$Project`"") {
        Write-Host "[harbor] project '$Project' present - ok."; $done = $true; break
    }
    $code = (curl.exe -sk -o NUL -w "%{http_code}" -u "admin:Harbor12345" `
        -X POST "$base/projects" -H "Content-Type: application/json" -d "@$($bodyFile.FullName)")
    switch ($code) {
        "201" { Write-Host "[harbor] project '$Project' created (public)."; $done = $true }
        "409" { Write-Host "[harbor] project '$Project' already exists - ok."; $done = $true }
        default {
            Write-Host "[harbor] project API HTTP $code (attempt $i) - core not ready yet, retrying in 5s..."
            Start-Sleep -Seconds 5
        }
    }
    if ($done) { break }
}
Remove-Item -Path $bodyFile -Force -ErrorAction SilentlyContinue
if (-not $done) { throw "harbor project create failed after retries (last HTTP $code)" }
