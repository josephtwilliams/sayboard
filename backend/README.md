# Account server

The standalone server serves the app and a same-origin account API. SQLite is the default for one VPS; ordinary PostgreSQL is an optional adapter. Setup, account provisioning, backup and password reset are in [the self-hosting guide](../docs/SELF-HOSTING.md).

## Loopback development

Use Node 24 LTS and run these commands from the repository root in separate terminals:

```sh
NODE_ENV=development SAYBOARD_LOCAL_DEV=1 npm run --prefix backend dev
npm run dev -- --config backend/vite.local.config.mjs
```

This explicit development mode binds only to loopback and seeds `admin` / `admin` when missing. It refuses forwarding headers and remote peers. The production server never seeds this account and rejects local-only identities. Do not expose the development mode through a tunnel.

The default development database is `backend/.data/sayboard.sqlite`. Production requires an explicitly configured absolute database path. Data and snapshots remain outside Git.

## Frontend integration contract

All responses are JSON with `Cache-Control: no-store`. Use `credentials: "same-origin"`. Cookies are server-set, HttpOnly, SameSite=Strict, scoped to `/`, and expire after eight hours. `expiresAt` is a Unix timestamp in milliseconds. Local HTTP uses `sayboard_session` without Secure; hosted HTTPS uses `__Host-sayboard_session` with Secure and no Domain attribute. Keep CSRF tokens in memory only, never passwords or session tokens in localStorage. Board payloads use the shared stage-two parser: `size` is `standard`, `large` or `extra-large` (legacy omission defaults to `standard`), and `icon` retains the complete bundled Lucide or emoji ID. Empty slots and stable tile IDs persist unchanged; unknown sizes/symbols are rejected.

| Request                 | Input                                                       | Success                                                                      |
| ----------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/auth/capabilities` | No body | `{ state: "disabled" \| "enabled" }`; configuration discovery, no session or board |
| `POST /api/auth/login`  | `{ "username": "admin", "password": "admin" }`              | `{ account: { username }, csrfToken, expiresAt }`, sets fresh session cookie |
| `GET /api/auth/session` | No body                                                     | Same session info; recovers in-memory CSRF after reload                      |
| `POST /api/auth/logout` | No body, `X-CSRF-Token` header                              | `{ "ok": true }`, revokes session and clears cookie                          |
| `GET /api/board`        | No body                                                     | `{ board: Board \| null, revision: number }`; missing board has revision `0` |
| `PUT /api/board`        | `{ board: Board, revision: number }`, `X-CSRF-Token` header | `{ board: Board, revision: number }`, increments revision                    |

Send `Content-Type: application/json` for login and board writes. `Board` is the version-2 category shape from `src/board.ts`; the shared parser explicitly migrates version-1 words without changing their slots. Root and category boards are transferred together. The server uses the same `parseBoard` validator. It strips unknown fields, bounds the request to 100 KB and derives the owner exclusively from the session. There is no account ID or board ID parameter. A submitted owner field cannot access another account.

Integration sequence:

1. Check `/api/auth/capabilities` on entry to account mode. Only `200 { state: "disabled" }` means accounts are deliberately disabled. Remember that state in memory for the page session, omit sign-in controls and session checks, and offer an explicit availability recheck. `enabled` describes configuration, not storage health. With enabled accounts, check `/api/auth/session`; show login on `401` and retain the device board on every failure. Capability failures are errors, never implicit disablement.
2. After login, read `/api/board`. Use `starterBoard()` for `board: null`, retaining revision `0`. Import a device-only board only after a deliberate user choice; never silently upload existing vocabulary.
3. Keep the returned revision and CSRF token in memory. Save a caregiver draft with `PUT /api/board`. Replace the displayed saved board and revision only after `200`.
4. On `409`, retain the draft and offer reload or export. Do not retry with a guessed revision. On a failed save, keep the draft/export available.
5. On `401`, keep unsaved edits available but stop account writes. On account switch/logout, clear the previous account's board and session state before loading another account. Do not fall back to a previous account's cache.

Errors are `{ "error": "code" }`. `400` indicates invalid input/JSON or unsupported query parameters; `401` indicates failed login or missing/expired session; `403` indicates local/origin/CSRF rejection; `404` unknown route; `405` wrong method; `409` stale revision; `413` oversized body; `415` wrong content type; `429` login budget/concurrency limit with `Retry-After: 300`; `503` authentication configuration, trusted client metadata or storage unavailable. Never log passwords, cookies, CSRF tokens or board payloads. Display a recoverable service-unavailable state if the static baseline has no API; do not send development credentials to an online origin.

## Verification

```sh
npm run --prefix backend check
npm run build:server
node scripts/verify-vps.mjs
```

The VPS check requires the container image built as `sayboard:publication-review`. It starts an isolated local HTTPS proxy and actual Node/SQLite server, uses synthetic accounts, and removes only its own test volumes afterward. It does not touch a deployed service.

## Public teacher workspaces

For hosted SQLite, set `SAYBOARD_AUTH_ENABLED=1` and `SAYBOARD_SIGNUP_ENABLED=1` to let teachers create their own workspaces at `/teacher`. Signup is off by default. PostgreSQL and local development do not support public signup. Invalid settings fail closed.

`SAYBOARD_PUBLIC_ACCOUNT_LIMIT` is a positive integer, defaulting to 100 current public accounts. This is an operational limit, not a measured hosting capacity. Deleting a public account releases its place. Password resets do not. Existing per-account board limits still apply. Public credential requests share a persisted five-minute limit of 10 per peer and 100 across the host. Excess requests return a retryable error. Password hashing shares the existing concurrency budget with sign-in and invitation activation.

Registration signs the teacher in and shows a recovery kit before classroom creation. Teachers must save the code privately. A code can recover the account once and is replaced after use. Recovery changes the password, revokes teacher sessions and pending password-reset invitations, and keeps classrooms and learner links. Turning off signup leaves recovery available. Ordinary password teachers can replace a lost code from **Recovery kit** after confirming their current password. Google accounts use Google recovery. Operators use the existing administrator reset process. Losing both password and code requires administrator help.

Only code hashes are stored. CLI and invitation password resets revoke recovery codes. Back up the SQLite database using the existing backup procedure so recovery records and public-account counts stay with the accounts.
