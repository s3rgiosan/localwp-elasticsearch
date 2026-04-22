# LocalWP Elasticsearch

A [LocalWP](https://localwp.com/) add-on that runs a per-site Elasticsearch container on demand.

## What it does

- Adds an **Elasticsearch** row to each site's "Utilities" panel with:
  - A master toggle to enable Elasticsearch for the site.
  - State, Host URI, Version selector, and an optional **ElasticPress** sub-toggle.
- On the **first site start** after enabling, creates a dedicated Docker container for the site (`localwp-elasticsearch-<siteId>`) using the selected Elasticsearch version. The container is reused across site restarts.
- Publishes the container on a stable per-site `localhost` port (persisted in site data) so you can bookmark the URI in GUI clients like [Elasticvue](https://elasticvue.com/).
- Automatically selects a native image when available (`linux/arm64` on Apple Silicon, `linux/amd64` elsewhere) and falls back gracefully when a given ES tag ships only one platform.
- When ElasticPress is toggled on, writes a marked block to `wp-config.php`:

  ```php
  // BEGIN Local Elasticsearch
  define( 'EP_HOST', 'http://localhost:<port>' );
  // END Local Elasticsearch
  ```

  Toggling off removes that block.
- Stops the container on site stop or when the ES toggle is turned off. The container and its data volume are preserved; only the "Confirm" action on a major-version change removes them.
- Stops any still-running managed containers when LocalWP itself quits.

## Requirements

- [LocalWP](https://localwp.com/) 9+
- **Docker running on your host machine either with [Docker Desktop](https://www.docker.com/products/docker-desktop/) or [Colima](https://github.com/abiosoft/colima#docker).** The add-on talks to your host's Docker daemon via the `docker` CLI — it does **not** spin up a Docker instance inside LocalWP, and it does not use any container runtime bundled with LocalWP. If Docker isn't running, the add-on surfaces "Docker not running" in the panel and does nothing.
- Developed and tested on **macOS**. Linux/Windows paths and permission prompts are not covered here.

## First-run macOS permission prompt

The first time the add-on writes `EP_HOST` to your site's `wp-config.php`, macOS shows a TCC dialog:

> "Local" would like to access data from other apps.

Click **Allow**. Without it, the `EP_HOST` constant can't be written and ElasticPress won't know where Elasticsearch lives. The prompt only appears once per macOS user.

## Installation

For development / local install:

```bash
git clone <repo> localwp-elasticsearch
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
3. If the site isn't running yet, the panel hints "Start site to create the container". If it is running, it says "Restart site to create the container". Start or restart the site to actually create the container on first enablement.
4. Once the container is running, the State row flips from `Starting…` to `Running` and the Host row shows `http://localhost:<port>`.
5. Paste the Host URI into Elasticvue (or any other client).
6. To wire up ElasticPress, flip the **ElasticPress** sub-toggle. It writes the `EP_HOST` constant to `wp-config.php`. Toggle off to remove.

### Lifecycle

| Action | Effect |
|---|---|
| ES toggle **on** (container exists) | Starts the container. |
| ES toggle **on** (container missing) | Stores the intent; container is created on next site start. |
| ES toggle **off** | Stops the container (does not remove it). |
| Site **start** | Starts/creates the container if intent is on. |
| Site **stop** | Stops the container if running. |
| LocalWP **quit** | Stops any still-running managed containers. |

### Version changes

- **Minor/patch:** pick a new version and restart the site; the existing data volume is reused. A "Restart site to apply" hint appears next to the selector.
- **Major:** a warning appears below the version select with a **Confirm** button that removes the container and the data volume. If the site is running, the new container is started immediately; otherwise it comes up on the next site start. You'll need to run an ElasticPress index sync afterward.

### RAM awareness

Each running Elasticsearch container uses about 512 MB of heap. Once more than 2 sites are running ES simultaneously, the panel shows a warning with the aggregate RAM estimate.

### Data persistence

Per-site data is stored in a Docker volume named `localwp-elasticsearch-<siteId>-data`. It survives site restarts, ES toggle off/on, and container recreation. It's only deleted when you use the "Confirm" button in the major-version warning.

## Development

```bash
npm install
npm run watch   # tsc --watch, emits to lib/
```

Restart LocalWP (or reload the addon) to pick up changes to the main process. Renderer changes are picked up on panel re-render.

## Uninstall

Remove the add-on from `~/Library/Application Support/Local/addons/`, then clean up leftover Docker resources:

```bash
docker ps -a --filter "label=com.localwp.addon=elasticsearch" --format "{{.Names}}" | xargs -r docker rm -f
docker volume ls --filter "name=localwp-elasticsearch-" --format "{{.Name}}" | xargs -r docker volume rm
```

If you'd like a clean `wp-config.php`, remove the `// BEGIN Local Elasticsearch` … `// END Local Elasticsearch` block from each site's `wp-config.php` by hand (or toggle the ElasticPress sub-toggle off before uninstalling).

## Caveats

- LocalWP has no public API to gate a site's "ready" state on an external dependency. The site will show as running before Elasticsearch is reachable; we surface this in the addon UI as `Starting…`.

## License

MIT
