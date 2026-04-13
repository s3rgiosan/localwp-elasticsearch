# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-04-13

### Changed

- `EP_HOST` block in `wp-config.php` now uses WordPress-style spacing: `define( 'EP_HOST', '...' );`.

### Fixed

- Keep the existing `EP_HOST` in sync: refresh the managed block when present, or update an out-of-block `define( 'EP_HOST', ... )` in place instead of inserting a duplicate.

## [1.0.0] - 2026-04-13

### Added

- Per-site Elasticsearch container lifecycle tied to Local's `siteStarted` / `siteStopped` hooks.
- Utilities panel with ES toggle, State, Host URI, Version selector, and an opt-in **ElasticPress** sub-toggle.
- Explicit ElasticPress toggle that writes/removes the `EP_HOST` marked block in `wp-config.php` (derived from wp-config state, not stored separately).
- Stable per-site host port: first-time container creation picks a free port and persists it in site data so `EP_HOST` stays valid across restarts.
- Architecture-aware image selection: on Apple Silicon the add-on queries `docker manifest inspect`, uses `linux/arm64` when the image publishes it, and falls back to `linux/amd64` (or omits `--platform` for single-arch tags) otherwise.
- Supported Elasticsearch versions: **5.2** and **7.17.28** (default is `7.17.28`, matching the 7.10-compat target used by ElasticPress and ElasticPress.io).
- Readiness polling against `/_cluster/health` before surfacing the Host URI.
- Major-version change workflow: inline warning with a **Confirm** button that removes the container and data volume (and recreates them when the site is running).
- "Start/Restart site to create the container" hint next to the ES toggle; "Restart site to apply" next to the version selector.
- Startup reconciliation of the stored version against the currently deployed image, so an unconfirmed major-version selection reverts on Local launch.
- Shutdown handler that stops all managed containers when Local quits.
- RAM-usage warning when more than two Elasticsearch containers run simultaneously.

### Behavior

- ES toggle is state-aware:
  - On (container exists) → starts the container.
  - On (container missing) → stores intent; container is created on next site start.
  - Off → stops the container, does not remove it.
- Container env flags branched per major: `xpack.security.enabled=false` is only passed for ES 6+ (X-Pack was a separate plugin in 5.x).
