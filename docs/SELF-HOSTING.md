# Run your own Sayboard

The free app needs no account service. Optional accounts use the same server and a local SQLite database. There is no managed-service dependency, public signup or email requirement. Operators create accounts and reset passwords through a server command.

## Deploy on a VPS with Docker Compose

Use a Linux VPS with Docker Engine and Docker Compose, persistent disk space and a hostname pointing at the server. Allow inbound TCP ports 80 and 443. Obtain this repository's source and run:

```sh
cp .env.example .env
```

Set `SAYBOARD_DOMAIN` to your hostname. Leave `SAYBOARD_AUTH_ENABLED=0` for the free app, or set it to `1` for account backups. Then run:

```sh
docker compose up -d --build
```

Caddy obtains an HTTPS certificate and forwards requests to the loopback-only Node server. The proxy shares the app's network namespace; the account API is not exposed on a separate public port. Both services restart after a host reboot. No cloud credentials are required.

The first build downloads pinned source dependencies for the speech components. The runtime image contains built assets and bundled server code. It runs as an unprivileged user and needs no npm install at startup.

The `boards` volume contains the SQLite database and retained source archives. Keep it across upgrades. `docker compose down` preserves named volumes. Deleting this volume deletes account records and previously published source archives.

For an upgrade, back up first and run `docker compose up -d --build`. Compose recreates the proxy when the app's network namespace changes. For a manual restart, run `docker compose restart app` and then `docker compose restart proxy`, in that order. Restarting both simultaneously can race the shared namespace setup.

## Create or reset an account

Use a username with letters, digits, underscores or hyphens. The reserved development username `admin` cannot authenticate in production. Passwords need 16 to 256 characters. This Bash prompt hides the password and passes it on stdin, rather than in process arguments or environment variables:

```bash
read -r -s -p 'New password: ' sayboard_password
printf '\n'
printf '%s' "$sayboard_password" | docker compose exec -T app node server-dist/manage.cjs create teacher
unset sayboard_password
```

To reset an existing account, replace `create teacher` with `reset-password teacher`. A reset revokes that account's existing sessions. Account commands never seed demonstration credentials or overwrite an existing account automatically.

Open the site, enter caregiver mode, expand **Backup and transfer**, and sign in. Choose explicitly when to save or load a copy. Saving an account copy does not replace the working local board. A loaded copy first becomes a caregiver draft; **Save board** applies it to the device.

## Back up and restore

Create a consistent SQLite snapshot while the server is running:

```sh
docker compose exec app mkdir -p /data/backups
docker compose exec app node server-dist/manage.cjs backup /data/backups/sayboard-backup.sqlite
docker compose cp app:/data/backups/sayboard-backup.sqlite /srv/backups/sayboard-backup.sqlite
```

Create the destination backup directory on the host first and restrict access to it. The command refuses to overwrite an existing snapshot. Rotate names and store encrypted off-server copies. Database contents are not encrypted by the app.

Also back up `/data/source` and Caddy's certificate volume. Source archives are public software, but their immutable URLs must remain available across upgrades. To restore a database, stop both services, replace the SQLite file from a verified snapshot, remove obsolete WAL and SHM companions only while the server is stopped, and start both services. Test restore with demonstration accounts before relying on the backup.

When moving an already published instance, copy its retained source tree into the new `/data/source` before serving the replacement. Independent new installations do not fetch the official website. Optional build-time `SAYBOARD_SOURCE_ORIGIN` and `SAYBOARD_SOURCE_POLICY` can import checked previous archives from an existing HTTPS origin during migration.

## Run without Docker

Install Node 24 LTS, npm and Python 3. Build from a clean checkout:

```sh
npm ci --ignore-scripts
npm run build
npm run build:server
```

Run the server under a dedicated unprivileged Linux user. Configure a service manager with these server-only settings:

```text
NODE_ENV=production
SAYBOARD_SERVER_ENTRY=1
SAYBOARD_ORIGIN=https://boards.example.org
SAYBOARD_PORT=8080
SAYBOARD_STATIC_DIR=/opt/sayboard/dist
SAYBOARD_DATA_DIR=/var/lib/sayboard
SAYBOARD_AUTH_ENABLED=1
SAYBOARD_STORAGE=sqlite
SAYBOARD_DATABASE_PATH=/var/lib/sayboard/sayboard.sqlite
```

Start `node /opt/sayboard/server-dist/server.cjs`. The process binds to `127.0.0.1`. Put an HTTPS reverse proxy on the same host and use [deploy/Caddyfile](../deploy/Caddyfile) as the reference. It must overwrite Host, X-Forwarded-Host, X-Forwarded-Proto and X-Forwarded-For from the actual connection. The server accepts a single client IP only through this loopback boundary. Do not expose the Node listener publicly.

For a free server without accounts, set `SAYBOARD_AUTH_ENABLED=0` and omit database settings. The data directory still retains published source archives. PostgreSQL is an optional advanced adapter; see [backend/POSTGRES.md](../backend/POSTGRES.md).

## Serve only the static app

Run `npm run build`, then serve the complete `dist/` directory with any static HTTPS server. Keep `/source/` and every older source release that the instance has served. Serve `.wasm` as `application/wasm`. Local preview is `npm run preview -- --port 5189`.

A static host does not back up boards. Changing hostname or browser profile changes where local boards are stored. Export before moving. The optional voice model downloads from pinned public URLs on demand; device speech does not need that model. Offline page startup and actual audio need verification on the intended device.

### Official static website

The official free website can continue on Vercel while account hosting runs separately on a VPS. Vercel serves the browser app and does not supply its storage or authentication. Independent builds keep the default empty source-retention policy and need no connection to the official website.

The existing official site has already published source archives. Its Vercel project uses `npm ci --ignore-scripts`, output directory `dist`, and this build command:

```sh
SAYBOARD_SOURCE_ORIGIN=https://sayboard.vercel.app SAYBOARD_SOURCE_POLICY=deploy/official-source-policy.json npm run build
```

The operator-owned policy records the source releases that must remain available on that website. The build imports its existing archives and rejects missing or changed required releases. It does not put a Vercel dependency in the application. Before replacing the production deployment, verify every previously served manifest and archive remains accessible. Keep external-fork deployment authorization enabled in Vercel.
