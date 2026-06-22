-- Per-order resource identity: the values field (named by the chart view's
-- "identity" JSON pointer, e.g. gateways[0].name) that drives the rendered
-- resource names. Empty when no view/identity is published (the service falls
-- back to service_name). Together with (cluster, namespace, chart_name) it stops
-- two orders of one chart from rendering colliding resource names into the same
-- namespace, which would make their ArgoCD Applications fight over the objects.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS resource_identity TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_namespace_identity
  ON requests (cluster, namespace, chart_name, resource_identity)
  WHERE deleted_at IS NULL AND namespace <> '' AND resource_identity <> '';
