import { parseBoard, serializeBoard, type Board } from "../src/board.js";
import type { Account, SavedBoard, Session, Store } from "./store-contract.js";

export const POSTGRES_SCHEMA_VERSION = 2;
export type Query = (
  sql: string,
  params: (string | number)[],
) => Promise<{ rows: unknown[] }>;

export class PostgresStore implements Store {
  constructor(private readonly query: Query) {}

  async assertSchema(): Promise<void> {
    const row = record(
      (
        await this.query(
          "SELECT version FROM sayboard.schema_version WHERE singleton = TRUE",
          [],
        )
      ).rows[0],
    );
    if (!row || row.version !== POSTGRES_SCHEMA_VERSION)
      throw new Error("Unsupported PostgreSQL storage schema");
  }
  async account(username: string): Promise<Account | null> {
    const row = (
      await this.query(
        `SELECT id, username, password_hash, local_only
      FROM sayboard.accounts WHERE username = $1 AND local_only = FALSE AND lower(username) <> 'admin'`,
        [username],
      )
    ).rows[0];
    return account(row);
  }
  async session(hash: string, now: number): Promise<Session | null> {
    const row = record(
      (
        await this.query(
          `SELECT a.id, a.username, a.password_hash, a.local_only, s.expires_at
      FROM sayboard.sessions s JOIN sayboard.accounts a ON a.id = s.account_id
      WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.local_only = FALSE AND lower(a.username) <> 'admin'`,
          [hash, now],
        )
      ).rows[0],
    );
    if (!row) return null;
    const owner = account(row);
    if (!owner) return null;
    return { account: owner, expiresAt: safeInteger(row.expires_at) };
  }
  async createSession(
    hash: string,
    accountId: string,
    expiresAt: number,
  ): Promise<void> {
    await this.query(
      `INSERT INTO sayboard.sessions(token_hash, account_id, expires_at)
      VALUES ($1, $2, $3)`,
      [hash, accountId, expiresAt],
    );
  }
  async deleteSession(hash: string): Promise<void> {
    await this.query("DELETE FROM sayboard.sessions WHERE token_hash = $1", [
      hash,
    ]);
  }
  async board(accountId: string): Promise<SavedBoard | null> {
    return saved(
      (
        await this.query(
          "SELECT payload, revision FROM sayboard.boards WHERE account_id = $1",
          [accountId],
        )
      ).rows[0],
    );
  }
  async saveBoard(
    accountId: string,
    board: Board,
    revision: number,
  ): Promise<SavedBoard | null> {
    const payload = serializeBoard(board);
    const result =
      revision === 0
        ? await this.query(
            `INSERT INTO sayboard.boards(account_id, payload, revision) VALUES ($1, $2::jsonb, 1)
        ON CONFLICT (account_id) DO NOTHING RETURNING payload, revision`,
            [accountId, payload],
          )
        : await this.query(
            `UPDATE sayboard.boards SET payload = $1::jsonb, revision = revision + 1
        WHERE account_id = $2 AND revision = $3 RETURNING payload, revision`,
            [payload, accountId, revision],
          );
    return saved(result.rows[0]);
  }
  async loginAvailable(key: string, now: number): Promise<boolean> {
    const row = record(
      (
        await this.query(
          "SELECT count FROM sayboard.login_limits WHERE key = $1 AND expires_at > $2",
          [key, now],
        )
      ).rows[0],
    );
    return !row || safeInteger(row.count) < 10;
  }
  async allowLogin(key: string, now: number): Promise<boolean> {
    // One atomic upsert serializes competing instances. Expired windows reset
    // under the same row lock; saturated counts never overflow an integer.
    const row = record(
      (
        await this.query(
          `INSERT INTO sayboard.login_limits(key, count, expires_at) VALUES ($1, 1, $2)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN sayboard.login_limits.expires_at <= $3 THEN 1 ELSE LEAST(sayboard.login_limits.count + 1, 11) END,
        expires_at = CASE WHEN sayboard.login_limits.expires_at <= $3 THEN EXCLUDED.expires_at ELSE sayboard.login_limits.expires_at END
      RETURNING count`,
          [key, now + 300_000, now],
        )
      ).rows[0],
    );
    if (!row) throw new Error("Missing rate limit result");
    const count = safeInteger(row.count);
    if (count < 1 || count > 11) throw new Error("Invalid rate limit count");
    return count <= 10;
  }
}
function record(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid PostgreSQL row");
  return Object.fromEntries(Object.entries(value));
}
function account(value: unknown): Account | null {
  const row = record(value);
  if (!row) return null;
  if (
    typeof row.id !== "string" ||
    typeof row.username !== "string" ||
    typeof row.password_hash !== "string" ||
    row.local_only !== false ||
    row.username.toLowerCase() === "admin"
  )
    throw new Error("Invalid hosted account row");
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    localOnly: false,
  };
}
function saved(value: unknown): SavedBoard | null {
  const row = record(value);
  if (!row) return null;
  const revision = safeInteger(row.revision);
  if (revision < 1) throw new Error("Invalid saved revision");
  return { board: parseBoard(row.payload), revision };
}
function safeInteger(value: unknown): number {
  // pg returns BIGINT as strings by default. Never change its global parsers.
  const number =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
    throw new Error("Invalid PostgreSQL integer");
  return number;
}
