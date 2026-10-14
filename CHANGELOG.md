# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-10-14

### Fixed

- The Elasticsearch entry in the site's Tools tab shows its name again.
- Each value and control in the panel lines up with its label, and banners appear below the control they belong to.

## [1.2.0] - 2026-10-14

### Added

- The panel reports when Docker creates the Elasticsearch container but leaves it stopped, and asks for a Docker restart. Images are pulled as a separate step, so starting a container times out after 60 seconds.
- Support for OrbStack and Rancher Desktop, with the `docker` CLI also found in `~/.docker/bin`, `/Applications/Docker.app/Contents/Resources/bin`, `~/.rd/bin`, `~/.rancher-desktop/bin`, `~/.orbstack/bin` and `/usr/bin`.
- The add-on uses the active Docker context, for example one selected with `docker context use colima`.
- The panel shows "Docker not found" when the `docker` CLI is missing and "Docker not running" when the daemon is unavailable.
- The panel shows a loading state and disables its controls until the first status arrives.
- The confirmation dialog for a major version change closes as soon as the major version change is resolved, and it names the site and focuses **Cancel** when it opens.
- The panel refreshes every 2 seconds while Elasticsearch starts, every 5 seconds once it is ready and every 10 seconds otherwise, so Docker coming back or a new error appears without reopening the panel.
- Turning Elasticsearch on while the site is running creates or starts the container immediately.
- Turning Elasticsearch off removes the `EP_HOST` block from `wp-config.php`.
- If starting the container fails after turning Elasticsearch on, the toggle turns back off and the panel shows the error.
- The panel shows "Container is created on next site start." when the site is stopped and "Applies on next site start" for pending version changes.
- Major version changes use a **Delete data and recreate** button that opens a confirmation dialog, and the add-on starts a different major version on an existing data volume only after the dialog is confirmed.
- Minor and patch version changes on a running site with Elasticsearch enabled recreate the container on the new image immediately and keep the data volume.
- Deleting a site removes its container and data volume. Containers and volumes of sites deleted while Docker was unavailable are removed on the next Local launch or as soon as Docker becomes available.
- Running add-on containers whose site is not running are stopped on Local launch or as soon as Docker becomes available.
- An existing `EP_HOST` define with a literal string in `wp-config.php` is commented out with the prefix `// Disabled by Local Elasticsearch: ` and restored when the block is removed.
- A new port is picked automatically when the stored port is taken or shared with another site, such as a cloned site, and an existing `EP_HOST` block is updated. A site whose container is bound to the shared port keeps it.
- Docker calls have timeouts, and cleanup on Local quit gives up after 15 seconds so Local can always quit.
- A container created with different settings is recreated on the next site start, and the data volume is kept.

### Changed

- Local's site start and stop complete without waiting for Docker. Container work for each site runs in the background in the order Local requested it, and the panel shows `Starting…` until the cluster health is green or yellow.
- Recreating a running container for a version or settings change stops Elasticsearch gracefully first.
- An image already present locally is used without a registry lookup.
- Writes to `wp-config.php` are atomic and keep the file mode and line endings.
- The ElasticPress sub-toggle can be turned off even when Elasticsearch is stopped.
- Elasticsearch 5.2 starts with the heap setting only. The `discovery.type` and `xpack.security.enabled` settings apply to 6.x and later.
- Elasticsearch 7.x starts with `cluster.routing.allocation.disk.watermark.enable_for_single_data_node=true`, which clears its only deprecation warning, and `ingest.geoip.downloader.enabled=false`, which skips the GeoIP database download at startup.
- Site data is read and written through Local's `siteData` service.
- Installing from a clone builds `lib` automatically, and each build starts from a clean `lib`.

### Fixed

- The add-on shows an error and leaves `wp-config.php` untouched when an existing `EP_HOST` has a value it cannot rewrite, such as `getenv( ... )` or a define split across lines.
- An existing `EP_HOST` define followed by a line comment is recognised in files with CRLF line endings.
- The panel reports an unreadable `wp-config.php`, and a site start with an unreadable file reports the error.
- Turning Elasticsearch on stops the container again when a later step fails.
- A startup error is reported only for the most recent start of a running site with Elasticsearch on.
- The `docker` CLI is found again after it moves to another install location.
- The panel reports an error when the container exits during startup.
- The panel applies only the latest status response, and a successful refresh clears earlier refresh errors.
- The panel shows an error reported by both an action and the status once.

### Security

- Docker is called with an argument list and site IDs are validated.
- Elasticsearch is published on `127.0.0.1` only.
- The temporary file used for atomic `wp-config.php` writes ends in `.php`, so the web server never serves it as plain text.

## [1.1.0] - 2026-04-22

### Added

- Support for [Colima](https://github.com/abiosoft/colima) as an alternative to Docker Desktop. The add-on now resolves the `docker` binary from common Homebrew locations (`/opt/homebrew/bin/docker`, `/usr/local/bin/docker`) in addition to `PATH`. Props [@theskinnyghost](https://github.com/theskinnyghost).

### Fixed

- Report a clear error when the `docker` CLI cannot be found.

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
- ES toggle is state-aware: turning it on with an existing container starts the container, turning it on with a missing container stores the setting and creates the container on next site start, and turning it off stops the container without removing it.
- Container env flags are branched per major: `xpack.security.enabled=false` is only passed for ES 6+ (X-Pack was a separate plugin in 5.x).

[Unreleased]: https://github.com/s3rgiosan/localwp-elasticsearch/compare/1.2.1...HEAD
[1.2.1]: https://github.com/s3rgiosan/localwp-elasticsearch/compare/1.2.0...1.2.1
[1.2.0]: https://github.com/s3rgiosan/localwp-elasticsearch/compare/1.1.0...1.2.0
[1.1.0]: https://github.com/s3rgiosan/localwp-elasticsearch/compare/1.0.1...1.1.0
[1.0.1]: https://github.com/s3rgiosan/localwp-elasticsearch/compare/1.0.0...1.0.1
[1.0.0]: https://github.com/s3rgiosan/localwp-elasticsearch/releases/tag/1.0.0
