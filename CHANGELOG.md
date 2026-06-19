# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-19

First tagged release. The platform console (portal) lets teams self-serve
deployments from a chart catalog, with GitOps provisioning, an approval flow for
chart publications, OIDC auth, and observability.

### Added
- Self-service portal: order and upgrade products from a catalog, with GitOps
  provisioning into Argo CD applications and per-namespace resource identity
  uniqueness.
- Chart publications: categories, owners and a view document stored in the
  database, an approval state machine (submit, withdraw, revoke), and
  category/owner changes routed through approval.
- View documents: dynamic enums and computed columns, document validation, and a
  single canonical order view per chart.
- Catalog: add a chart by an arbitrary Harbor path with completeness checks,
  publication status on catalog cards, and a menu/catalog driven by publications.
- Builder UI: view-document and values.schema.json editor with a real order/
  product preview and inline format help.
- Auth: OIDC login via Keycloak, RP-initiated logout, return-to-page after
  re-login on 401, and RBAC roles (member, admin, support, security with an
  InfoSec section).
- Observability: platform metrics with a Grafana dashboard and structured,
  component-tagged logging.
- Collector: snapshots Kubernetes state into Valkey for the console.
- Portal serves the embedded SPA directly (nginx dropped) and exposes an About
  page with build version and links.
- Standalone documentation pages.
- CI/release pipeline on GitHub Actions: PR checks, tag + GitHub Release on
  merging a `release/*` PR, and multi-arch image publish to GHCR for portal and
  collector on `v*` tags.

[Unreleased]: https://github.com/awbait/console/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/awbait/console/releases/tag/v0.1.0
