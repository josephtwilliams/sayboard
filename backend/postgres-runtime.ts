import { Pool, type PoolConfig } from "pg";
import { emitBackendFailure } from "./backend-errors.js";
import { PostgresStore } from "./postgres-store.js";

export function postgresOptions(env: NodeJS.ProcessEnv): PoolConfig {
  if (
    env.NODE_ENV !== "production" ||
    env.SAYBOARD_STORAGE !== "postgres" ||
    env.SAYBOARD_LOCAL_DEV ||
    !env.DATABASE_URL
  )
    throw new Error("Hosted PostgreSQL storage is not configured");
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    throw new Error("Invalid PostgreSQL connection configuration");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.password ||
    url.pathname.length < 2 ||
    url.hash
  )
    throw new Error("Invalid PostgreSQL connection configuration");
  const mode = url.searchParams.get("sslmode");
  if (mode && !["require", "verify-ca", "verify-full"].includes(mode))
    throw new Error("PostgreSQL requires verified TLS");
  // pg URL SSL flags replace its SSL object. Normalize the provider's common
  // sslmode=require URL, then force certificate verification in pool options.
  for (const key of url.searchParams.keys()) {
    if (key !== "sslmode")
      throw new Error("Unsupported PostgreSQL connection option");
  }
  url.search = "";
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true },
    enableChannelBinding: true,
    max: 2,
    idleTimeoutMillis: 5000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
    allowExitOnIdle: true,
    application_name: "sayboard",
  };
}

// Call lazily from a future server-only handler. Importing this module does not
// connect, read credentials, run migrations, seed accounts or open a socket.
export function productionStoreFactory(env: NodeJS.ProcessEnv) {
  let pending: Promise<PostgresStore> | undefined;
  return () => {
    pending ??= initialize();
    return pending;
  };
  async function initialize(): Promise<PostgresStore> {
    const pool = new Pool(postgresOptions(env));
    // Prevent idle pool errors becoming uncaught events; request errors still
    // propagate. No credentials, SQL or submitted data are logged.
    pool.on("error", () => emitBackendFailure("postgres_idle_pool_error"));
    const store = new PostgresStore(async (sql, params) =>
      pool.query(sql, params),
    );
    try {
      await store.assertSchema();
      return store;
    } catch {
      await pool.end();
      pending = undefined;
      throw new Error("PostgreSQL storage unavailable or schema not applied");
    }
  }
}
