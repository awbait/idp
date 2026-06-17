# ingress-gateway (test fixture)

Minimal fixture used only by the `internal/harbor` unit tests (fake + real
client) so they can exercise catalog/schema/values extraction without vendoring
the full chart.

The real, deployable chart lives in [`charts/ingress-gateway`](../../../../../charts/ingress-gateway)
and is pushed to Harbor by `scripts/stand/50-charts.ps1`. At runtime the catalog
source is Harbor - this fixture is never used in `real` mode.
