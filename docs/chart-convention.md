# Chart registry convention (Harbor)

How charts are laid out in Harbor and how the portal + ArgoCD reference them.
This is the contract the real Harbor client (`internal/harbor/client.go`), the
GitOps layer (`internal/provisioning`), and the stand scripts (`deployments/kind/`)
all agree on.

## Layout

| Concept            | Harbor object        | Example                          |
|--------------------|----------------------|----------------------------------|
| Chart **category** | project              | `platform`, `managed-services`   |
| Chart **name**     | repository           | `ingress-gateway`                |
| Chart **version**  | artifact tag         | `3.1.0`                          |

- OCI reference: `oci://<harbor-host>/<project>/<chart>:<version>`.
- Push: `helm push <chart>.tgz oci://<harbor-host>/<project>` (the chart name and
  version come from `Chart.yaml`).
- The portal surfaces only the projects listed in `HARBOR_PROJECTS`
  (default `platform,managed-services`).

## How the portal reads it (`HARBOR_MODE=real`)

- **Metadata** (catalog list, versions, latest, digest) - Harbor API v2.0:
  `GET /api/v2.0/projects/{project}/repositories` and `.../repositories/{chart}/artifacts`.
  "Latest" is the newest artifact by push time (the "last tag" rule; no semver
  computation).
- **File bodies** (`values.yaml`, `README.md`, `values.schema.json`, `CHANGELOG.md`)
  - pulled from the chart's **OCI artifact** (`.tgz`) and extracted. Harbor's chart
  "additions" only expose `values.yaml`+`readme.md`, so the tarball is the single
  source that also yields the schema and changelog. The chart's `values.schema.json`
  is the **single source of truth** for the order form - there is no second copy.
- Auth is an optional robot account (`HARBOR_ROBOT_USER`/`HARBOR_ROBOT_TOKEN`); with
  none set the client runs anonymously, which works against a **public** project.
  `AllowedTeams` is always empty for real Harbor (no allowlist source in Harbor yet).

## How ArgoCD references it

The portal commits an `application.yaml` whose chart source `repoURL` is
`<CHART_REGISTRY>/<project>`, with `chart: <name>` and `version: <version>`
(`internal/provisioning` builds this from `cfg.ChartRegistry`). So `CHART_REGISTRY`
is the Harbor host (e.g. `host.docker.internal:8084` on the stand, the Harbor OCI
endpoint in prod).

## On the local stand (`deployments/kind/`)

A **minimal Harbor** (harbor-helm, Trivy off, self-signed TLS, persistent volumes
via KinD's local-path StorageClass) runs in KinD and is published at
`host.docker.internal:8084` (NodePort 30084) - the same
host name used by the portal (host/container) and by ArgoCD pods (via the CoreDNS
patch in `10-coredns.ps1`), so the registry host resolves identically everywhere.
The `platform` project is created **public** (`45-harbor-project.ps1`) so nobody
needs credentials to pull or to read the catalog; pushes (`50-charts.ps1`) use the
admin account. Self-signed TLS → `HARBOR_INSECURE_TLS=true` for the portal and
`insecure: true` on the ArgoCD repo secret.

This repo is **chart-agnostic** - it does not vendor deployable charts. Charts
(`ingress-gateway`, `egress`, …) live in their own location/repo and are published
to **Harbor** by their own pipeline. The portal only knows that some chart exists
in Harbor and pulls/serves it from there; ArgoCD likewise deploys straight from
Harbor. At runtime the catalog source is always Harbor (`HARBOR_MODE=real` is the
default).

The only chart-shaped thing in this repo is a **minimal test fixture** under
`internal/harbor/charts/<project>/<chart>/`, embedded for the `harbor` unit tests
and served by `HARBOR_MODE=fake` (tests + zero-infra dev only). It is never used
in `real` mode and is not a deployable chart.

For a local stand, seed Harbor once from an external chart directory:
`deployments/kind/50-charts.ps1 -ChartsDir <path>` (or `$env:STAND_CHARTS_DIR`) - it
pushes every chart subfolder there into the Harbor project. Without a source the
step is skipped; Harbor is expected to be populated separately.
