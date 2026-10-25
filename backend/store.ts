import { backup, DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { parseBoard, serializeBoard, type Board } from "../src/board.js";
import { randomUUID } from "node:crypto";
import { hashPassword } from "./password.js";
import { SqliteClassrooms } from "./classroom-store.js";
import { SqliteOnboarding } from "./onboarding.js";
import { SqliteGoogleStore } from "./google-store.js";

import type { Account, Session, SavedBoard, Store } from "./store-contract.js";

export class SqliteStore implements Store {
  private db: DatabaseSync;
  readonly classrooms: SqliteClassrooms;
  readonly onboarding: SqliteOnboarding;
  readonly google: SqliteGoogleStore;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, local_only INTEGER NOT NULL CHECK(local_only IN (0,1))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS boards (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        payload TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS login_limits (
        key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
      ) STRICT;
    `);
    this.classrooms = new SqliteClassrooms(this.db);
    this.onboarding = new SqliteOnboarding(this.db);
    this.google = new SqliteGoogleStore(this.db);
  }
  close() {
    this.db.close();
  }
  async backup(path: string): Promise<void> {
    await backup(this.db, path);
    chmodSync(path, 0o600);
  }
  deleteAccount(username: string): void {
    // Foreign keys also revoke sessions, device links and classroom records.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare("DELETE FROM accounts WHERE username = ? AND local_only = 0")
        .run(username);
      if (result.changes !== 1) throw new Error("Account not found");
      this.onboarding.removeInvitations(username);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async resetPassword(username: string, password: string): Promise<void> {
    const hash = await hashPassword(password);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const account = this.db
        .prepare(
          "SELECT id FROM accounts WHERE username = ? AND local_only = 0",
        )
        .get(username);
      if (!account || typeof account.id !== "string")
        throw new Error("Account not found");
      this.db
        .prepare("UPDATE accounts SET password_hash = ? WHERE id = ?")
        .run(hash, account.id);
      this.db
        .prepare("DELETE FROM sessions WHERE account_id = ?")
        .run(account.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async addAccount(
    username: string,
    password: string,
    localOnly = true,
  ): Promise<void> {
    this.db
      .prepare("INSERT INTO accounts VALUES (?, ?, ?, ?)")
      .run(
        randomUUID(),
        username,
        await hashPassword(password),
        localOnly ? 1 : 0,
      );
  }
  async seedLocalAdmin(): Promise<void> {
    // Idempotent; never resets a changed password or board.
    if (!(await this.account("admin"))) await this.addAccount("admin", "admin");
  }
  async account(username: string): Promise<Account | null> {
    return parseAccount(
      this.db
        .prepare("SELECT * FROM accounts WHERE username = ?")
        .get(username),
    );
  }
  async session(hash: string, now: number): Promise<Session | null> {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    const row = this.db
      .prepare(
        `SELECT accounts.*, sessions.expires_at FROM sessions
      JOIN accounts ON accounts.id = sessions.account_id WHERE token_hash = ? AND expires_at > ?`,
      )
      .get(hash, now);
    if (!row) return null;
    const account = parseAccount(row);
    if (!account || typeof row.expires_at !== "number")
      throw new Error("Invalid session row");
    return { account, expiresAt: row.expires_at };
  }
  async createSession(
    hash: string,
    accountId: string,
    expiresAt: number,
  ): Promise<void> {
    this.db
      .prepare("INSERT INTO sessions VALUES (?, ?, ?)")
      .run(hash, accountId, expiresAt);
  }
  async deleteSession(hash: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
  }
  async board(accountId: string): Promise<SavedBoard | null> {
    return parseSaved(
      this.db
        .prepare("SELECT * FROM boards WHERE account_id = ?")
        .get(accountId),
    );
  }
  async saveBoard(
    accountId: string,
    board: Board,
    revision: number,
  ): Promise<SavedBoard | null> {
    // Compare and swap in one statement: stale browser tabs cannot silently overwrite.
    const payload = serializeBoard(board);
    const result =
      revision === 0
        ? this.db
            .prepare(
              "INSERT INTO boards VALUES (?, ?, 1) ON CONFLICT(account_id) DO NOTHING RETURNING *",
            )
            .get(accountId, payload)
        : this.db
            .prepare(
              "UPDATE boards SET payload = ?, revision = revision + 1 WHERE account_id = ? AND revision = ? RETURNING *",
            )
            .get(payload, accountId, revision);
    return parseSaved(result);
  }
  async loginAvailable(key: string, now: number): Promise<boolean> {
    const row = this.db
      .prepare(
        "SELECT count FROM login_limits WHERE key = ? AND expires_at > ?",
      )
      .get(key, now);
    return !row || (typeof row.count === "number" && row.count < 10);
  }
  async allowLogin(key: string, now: number): Promise<boolean> {
    this.db.prepare("DELETE FROM login_limits WHERE expires_at <= ?").run(now);
    // Global peer budget, persisted across process restarts; bounds scrypt work.
    const row = this.db
      .prepare(
        `INSERT INTO login_limits VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count`,
      )
      .get(key, now + 5 * 60_000);
    return !!row && typeof row.count === "number" && row.count <= 10;
  }
}
type Row = ReturnType<ReturnType<DatabaseSync["prepare"]>["get"]>;
function parseAccount(row: Row): Account | null {
  if (!row) return null;
  if (
    typeof row.id !== "string" ||
    typeof row.username !== "string" ||
    typeof row.password_hash !== "string" ||
    (row.local_only !== 0 && row.local_only !== 1)
  )
    throw new Error("Invalid account row");
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    localOnly: row.local_only === 1,
  };
}
function parseSaved(row: Row): SavedBoard | null {
  if (!row) return null;
  if (typeof row.payload !== "string" || typeof row.revision !== "number")
    throw new Error("Invalid board row");
  return { board: parseBoard(JSON.parse(row.payload)), revision: row.revision };
}
