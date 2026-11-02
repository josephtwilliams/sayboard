import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { HttpError } from "./api-http.js";

export type RegistrationInput = { username: string; password: string };
export type RecoveryInput = RegistrationInput & { recoveryCode: string };
type SessionGrant = { sessionHash: string; expiresAt: number };
type Credentials = { passwordHash: string; recoveryHash: string };
export interface SelfServiceStore {
  register(
    input: Credentials &
      SessionGrant & { username: string; now: number; capacity: number },
  ): void;
  recover(
    input: Credentials &
      SessionGrant & { username: string; previousRecoveryHash: string },
  ): void;
  replace(input: {
    accountId: string;
    verifiedPasswordHash: string;
    recoveryHash: string;
  }): void;
  eligible(accountId: string): boolean;
  allowAttempt(peer: string, now: number): boolean;
}

export function invalidateCredentials(
  db: DatabaseSync,
  accountId: string,
): void {
  db.prepare("DELETE FROM sessions WHERE account_id=?").run(accountId);
  db.prepare(
    "UPDATE account_recovery SET token_hash=NULL WHERE account_id=?",
  ).run(accountId);
  db.prepare(
    "DELETE FROM account_invitations WHERE username=(SELECT username FROM accounts WHERE id=?) AND kind='reset'",
  ).run(accountId);
}

export class SqliteSelfService implements SelfServiceStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS account_recovery (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      token_hash TEXT, public_signup INTEGER NOT NULL CHECK(public_signup IN (0,1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS self_service_limits (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;`);
  }
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  eligible(accountId: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM accounts WHERE id=? AND local_only=0
      AND lower(username)<>'admin' AND password_hash LIKE 'scrypt$%'
      AND NOT EXISTS (SELECT 1 FROM account_operators WHERE account_id=accounts.id)
      AND NOT EXISTS (SELECT 1 FROM google_identities WHERE account_id=accounts.id)`,
      )
      .get(accountId);
  }
  register(
    input: Credentials &
      SessionGrant & { username: string; now: number; capacity: number },
  ): void {
    this.transaction(() => {
      if (
        this.db
          .prepare("SELECT 1 FROM accounts WHERE username=?")
          .get(input.username) ||
        this.db
          .prepare(
            "SELECT 1 FROM account_invitations WHERE username=? AND accepted_at IS NULL AND expires_at>?",
          )
          .get(input.username, input.now)
      )
        throw new HttpError(409, "username_unavailable");
      const count = this.db
        .prepare(
          "SELECT count(*) AS count FROM account_recovery WHERE public_signup=1",
        )
        .get();
      if (
        !count ||
        typeof count.count !== "number" ||
        count.count >= input.capacity
      )
        throw new HttpError(503, "signup_capacity_reached", {
          "Retry-After": "300",
        });
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO accounts VALUES (?,?,?,0)")
        .run(id, input.username, input.passwordHash);
      this.db
        .prepare("INSERT INTO account_recovery VALUES (?,?,1)")
        .run(id, input.recoveryHash);
      this.db
        .prepare("INSERT INTO sessions VALUES (?,?,?)")
        .run(input.sessionHash, id, input.expiresAt);
    });
  }
  recover(
    input: Credentials &
      SessionGrant & { username: string; previousRecoveryHash: string },
  ): void {
    this.transaction(() => {
      const account = this.db
        .prepare(
          `SELECT accounts.id FROM accounts JOIN account_recovery ON account_id=accounts.id
        WHERE username=? AND token_hash=?`,
        )
        .get(input.username, input.previousRecoveryHash);
      if (
        !account ||
        typeof account.id !== "string" ||
        !this.eligible(account.id)
      )
        throw new HttpError(401, "recovery_failed");
      invalidateCredentials(this.db, account.id);
      this.db
        .prepare("UPDATE accounts SET password_hash=? WHERE id=?")
        .run(input.passwordHash, account.id);
      this.db
        .prepare("UPDATE account_recovery SET token_hash=? WHERE account_id=?")
        .run(input.recoveryHash, account.id);
      this.db
        .prepare("INSERT INTO sessions VALUES (?,?,?)")
        .run(input.sessionHash, account.id, input.expiresAt);
    });
  }
  replace(input: {
    accountId: string;
    verifiedPasswordHash: string;
    recoveryHash: string;
  }): void {
    this.transaction(() => {
      if (
        !this.eligible(input.accountId) ||
        !this.db
          .prepare("SELECT 1 FROM accounts WHERE id=? AND password_hash=?")
          .get(input.accountId, input.verifiedPasswordHash)
      )
        throw new HttpError(401, "recovery_failed");
      this.db
        .prepare(
          `INSERT INTO account_recovery VALUES (?,?,0)
        ON CONFLICT(account_id) DO UPDATE SET token_hash=excluded.token_hash`,
        )
        .run(input.accountId, input.recoveryHash);
    });
  }
  allowAttempt(peer: string, now: number): boolean {
    return this.transaction(() => {
      this.db
        .prepare("DELETE FROM self_service_limits WHERE expires_at<=?")
        .run(now);
      const reserve = (key: string, limit: number) => {
        const row = this.db
          .prepare(
            `INSERT INTO self_service_limits VALUES (?,1,?)
          ON CONFLICT(key) DO UPDATE SET count=min(count+1,?) RETURNING count`,
          )
          .get(key, now + 300_000, limit + 1);
        return !!row && typeof row.count === "number" && row.count <= limit;
      };
      if (!reserve("global", 100)) return false;
      const key = `peer:${peer}`;
      if (
        !this.db
          .prepare("SELECT 1 FROM self_service_limits WHERE key=?")
          .get(key)
      ) {
        const active = this.db
          .prepare("SELECT count(*) AS count FROM self_service_limits")
          .get();
        if (!active || typeof active.count !== "number" || active.count >= 101)
          return false;
      }
      return reserve(key, 10);
    });
  }
}
