# LocalWP Elasticsearch

A [LocalWP](https://localwp.com/) add-on that runs a per-site Elasticsearch container on demand.

## What it does

- Adds an **Elasticsearch** row to each site's "Utilities" panel with:
  - A master toggle to enable Elasticsearch for the site.
  - State, Host URI, Version selector, and an optional **ElasticPress** sub-toggle.
- Creates a dedicated Docker container for the site (`localwp-elasticsearch-<siteId>`) using the selected Elasticsearch version. When the site is running, the container is created or started as soon as the toggle is turned on. When the site is stopped, the setting is saved and the container is created on the next site start. If starting fails, the toggle turns back off and the panel shows the error.
- Publishes the container on a stable per-site port on `127.0.0.1` (persisted in site data) so you can bookmark the URI in GUI clients like [Elasticvue](https://elasticvue.com/). If the stored port is taken or shared with another site (for example a cloned site), a new port is picked automatically and an existing `EP_HOST` block is updated. A site whose container is bound to the shared port keeps it, so the clone moves.
- Automatically selects a native image when available (`linux/arm64` on Apple Silicon, `linux/amd64` elsewhere) and falls back gracefully when a given ES tag ships only one platform.
- When ElasticPress is toggled on, writes a marked block to `wp-config.php`:

  ```php
  // BEGIN Local Elasticsearch
  define( 'EP_HOST', 'http://localhost:<port>' );
  // END Local Elasticsearch
  ```

  Toggling ElasticPress off, or turning Elasticsearch off, removes that block. The ElasticPress sub-toggle can be turned off even when Elasticsearch is stopped. Writes to `wp-config.php` are atomic (temporary file and rename) and keep the file mode and line endings.
- Stops the container on site stop or when the ES toggle is turned off. The container and its data volume are kept. Removing them happens when a major-version change is confirmed with **Delete data and recreate**, or when the site is deleted.
- On Local launch, or as soon as Docker becomes available, stops running add-on containers whose site is not running.
- On Local quit, stops running add-on containers. Cleanup gives up after 15 seconds so Local can always quit.
- Local's site start completes without waiting for Elasticsearch. The panel shows `Starting…` until the cluster health is green or yellow, and shows an error if the container exits during startup.

### Existing `EP_HOST` defines

If `wp-config.php` already defines `EP_HOST` with a literal string outside the marked block, that line is commented out with the prefix `// Disabled by Local Elasticsearch: ` and restored when the block is removed. If the existing `EP_HOST` has a value the add-on cannot rewrite (for example `getenv( ... )` or a define split across lines), the add-on leaves `wp-config.php` untouched and shows an error.

## Requirements

- [LocalWP](https://localwp.com/) (tested with 10.1)
- **Docker running on your host machine.** Supported runtimes:
  - [Docker Desktop](https://www.docker.com/products/docker-desktop/)
  - [Colima](https://github.com/abiosoft/colima#docker)
  - [OrbStack](https://orbstack.dev/)
  - [Rancher Desktop](https://rancherdesktop.io/)

  The add-on uses your host's Docker daemon through the `docker` CLI. The CLI is looked up in `/opt/homebrew/bin`, `/usr/local/bin`, `~/.docker/bin`, `/Applications/Docker.app/Contents/Resources/bin`, `~/.rd/bin`, `~/.rancher-desktop/bin`, `~/.orbstack/bin` and `/usr/bin`. The panel distinguishes "Docker not found" (no `docker` CLI) from "Docker not running" (daemon unavailable). Every Docker call has a timeout.

  The add-on uses the active Docker context. If you have more than one runtime installed, make sure the active context points at the one you want before starting sites (e.g. `docker context use colima`).
- Developed and tested on **macOS**. Linux and Windows are untested.

## First-run macOS permission prompt

The first time the add-on writes `EP_HOST` to your site's `wp-config.php`, macOS shows a TCC dialog:

> "Local" would like to access data from other apps.

Click **Allow**. Allowing access lets the add-on write the `EP_HOST` constant so ElasticPress finds Elasticsearch. The prompt appears once per macOS user.

## Installation

For development / local install:

```bash
git clone https://github.com/s3rgiosan/localwp-elasticsearch.git
cd localwp-elasticsearch
npm install
npm run build
```

Then symlink the folder into LocalWP's add-on directory and restart LocalWP:

```bash
ln -s "$PWD" "$HOME/Library/Application Support/Local/addons/localwp-elasticsearch"
```

Restart LocalWP and enable the add-on from the Add-ons page.

## Usage

1. Open a site and expand **Utilities**.
2. Flip the **Elasticsearch** toggle on. Supported versions: **5.2** (legacy minimum) and **7.17.28** (default).
3. If the site is running, the container is created or started immediately. If the site is stopped, the panel hints "Container is created on next site start." and the container is created when you start the site.
4. Once the container is running, the State row flips from `Starting…` to `Running` and the Host row shows `http://localhost:<port>`.
5. Paste the Host URI into Elasticvue (or any other client).
6. To wire up ElasticPress, flip the **ElasticPress** sub-toggle. It writes the `EP_HOST` constant to `wp-config.php`. Toggle off to remove.

### Lifecycle

| Action | Effect |
|---|---|
| ES toggle **on** (site running) | Creates or starts the container immediately. If starting fails, the toggle turns back off and the panel shows the error. |
| ES toggle **on** (site stopped) | Saves the setting; the container is created on next site start. |
| ES toggle **off** | Stops the container (the container is kept) and removes the `EP_HOST` block from `wp-config.php`. |
| Site **start** | Starts or creates the container if Elasticsearch is on. |
| Site **stop** | Stops the container if running. |
| Site **delete** | Removes the site's container and data volume. |
| LocalWP **launch** | Stops running add-on containers whose site is not running, and reverts an unconfirmed major version selection to the version of the data volume. |
| LocalWP **quit** | Stops running add-on containers (gives up after 15 seconds). |

### Version changes

- **Minor/patch:** pick a new version. If the site is running and Elasticsearch is on, the container is recreated on the new image immediately and keeps the same data volume. Otherwise the change applies on the next site start ("Applies on next site start" hint).
- **Major:** a warning appears below the version select with a **Delete data and recreate** button that opens a confirmation dialog. Confirming removes the container and the data volume. If Elasticsearch is on and the site is running, the new container starts immediately; otherwise it starts on the next site start. Until you confirm, the add-on refuses to start a different major version on an existing volume. Run an ElasticPress index sync afterward.

### RAM awareness

Each running Elasticsearch container uses about 512 MB of heap. Once more than 2 containers are running simultaneously, the panel shows a warning with the aggregate RAM estimate.

### Data persistence

Per-site data is stored in a Docker volume named `localwp-elasticsearch-<siteId>-data`. It survives site restarts, ES toggle off/on, and container recreation. It is deleted when you confirm **Delete data and recreate** in the major-version warning, or when the site is deleted.

## Development

```bash
npm install
npm run watch   # tsc --watch, emits to lib/
```

Restart LocalWP to pick up changes to both the main process and the renderer.

## Uninstall

Remove the add-on from `~/Library/Application Support/Local/addons/`, then clean up leftover Docker resources:

```bash
docker ps -a --filter "label=com.localwp.addon=elasticsearch" --format "{{.Names}}" | xargs -r docker rm -f
docker volume ls --filter "name=localwp-elasticsearch-" --format "{{.Name}}" | xargs -r docker volume rm
```

For a clean `wp-config.php`, turn Elasticsearch off for each site before uninstalling (this removes the `// BEGIN Local Elasticsearch` … `// END Local Elasticsearch` block), or remove the block by hand.

## Caveats

- LocalWP marks the site as running before Elasticsearch is reachable. The add-on panel shows `Starting…` until the cluster is ready.

## License

MIT
