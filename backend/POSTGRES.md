# Optional PostgreSQL storage

SQLite is the default standalone deployment. Use this ordinary PostgreSQL adapter when you need a separate database. It has no hosting-provider dependency.

Apply `migrations/001_postgres.sql`, then `migrations/002_board_categories.sql`, using a schema-owner role. Existing schema-version-1 databases need only migration 002. The runtime requires schema version 2 and never migrates during a request.

Create a separate runtime database role with only schema usage, SELECT on `sayboard.schema_version`, and the SELECT, INSERT, UPDATE and DELETE permissions needed on `sayboard.accounts`, `sayboard.sessions`, `sayboard.boards` and `sayboard.login_limits`. The server reads `schema_version` before use and does not start without it. Keep migration ownership separate. Run `migrations/maintenance.sql` as a scheduled database maintenance task to prune expired sessions and login budgets.

Password sign-in locks the account row while it creates a session. PostgreSQL requires UPDATE privilege on at least one account column for this lock. Grant `UPDATE (local_only)` on `sayboard.accounts` to the runtime role alongside SELECT. The schema constrains that column to FALSE, so this grant permits the lock without allowing password changes. See [PostgreSQL locking privileges](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE).

Configure the standalone server with `SAYBOARD_AUTH_ENABLED=1`, `SAYBOARD_STORAGE=postgres`, `SAYBOARD_ORIGIN` set to its exact HTTPS origin, and `DATABASE_URL` supplied privately. Use a PostgreSQL URL with a username, password and database name. TLS certificate verification is mandatory; set `NODE_EXTRA_CA_CERTS` for a private CA. Unknown connection URL options are rejected.

`postgres-runtime.ts` creates one bounded pool lazily, checks the schema before use and closes failed initialization. `postgres-store.ts` implements the same account contract as SQLite. Atomic revision comparisons reject stale writes. Login budgets are shared in PostgreSQL across server processes. The server logs no connection strings, submitted boards, cookies or passwords.

The SQLite account CLI does not manage PostgreSQL accounts. Provision UUID accounts with an application-compatible salted scrypt hash through your database administration process; never insert a plaintext password or copy the development admin account. Verify login, account isolation, password rotation, database backup and restore before accepting private records. PostgreSQL adapter tests execute the real migrations and queries against PGlite; the default VPS end-to-end check covers SQLite.
