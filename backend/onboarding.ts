import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { invalidateCredentials } from "./self-service.js";
import { HttpError } from "./api-http.js";

export type InvitationKind = "invite" | "reset";
export type Invitation = {
  username: string;
  kind: InvitationKind;
  expiresAt: number;
};
export interface OnboardingStore {
  isOperator(accountId: string): boolean;
  issue(
    operator: string,
    username: string,
    email: string | null,
    kind: InvitationKind,
    hash: string,
    now: number,
  ): Invitation;
  inspect(hash: string, now: number): Invitation;
  accept(hash: string, passwordHash: string, now: number): void;
  cancel(operator: string, username: string): void;
}
export const INVITE_MS = 48 * 60 * 60_000;
export const RESET_MS = 60 * 60_000;

export class SqliteOnboarding implements OnboardingStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS account_operators (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS account_invitations (
        username TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('invite', 'reset')), email TEXT,
        issued_by TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL, accepted_at INTEGER
      ) STRICT;
    `);
  }
  enableOperator(username: string): void {
    const account = this.db
      .prepare("SELECT id FROM accounts WHERE username=? AND local_only=0")
      .get(username);
    if (!account) throw new Error("Account not found");
    this.db
      .prepare("INSERT OR IGNORE INTO account_operators VALUES (?)")
      .run(account.id);
  }
  disableOperator(username: string): void {
    this.db
      .prepare(
        "DELETE FROM account_operators WHERE account_id IN (SELECT id FROM accounts WHERE username=?)",
      )
      .run(username);
  }
  isOperator(accountId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM account_operators WHERE account_id=?")
      .get(accountId);
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
  issue(
    operator: string,
    username: string,
    email: string | null,
    kind: InvitationKind,
    hash: string,
    now: number,
  ): Invitation {
    return this.transaction(() => {
      if (!this.isOperator(operator))
        throw new HttpError(403, "operator_required");
      const account = this.db
        .prepare("SELECT id, local_only FROM accounts WHERE username=?")
        .get(username);
      if (
        (kind === "invite" && account) ||
        (kind === "reset" && (!account || account.local_only !== 0))
      )
        throw new HttpError(409, "account_state_changed");
      const expiresAt = now + (kind === "invite" ? INVITE_MS : RESET_MS);
      this.db
        .prepare(
          `INSERT INTO account_invitations VALUES (?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(username) DO UPDATE SET token_hash=excluded.token_hash, kind=excluded.kind,
        email=excluded.email, issued_by=excluded.issued_by, expires_at=excluded.expires_at, accepted_at=NULL`,
        )
        .run(username, hash, kind, email, operator, expiresAt);
      return { username, kind, expiresAt };
    });
  }
  inspect(hash: string, now: number): Invitation {
    const row = this.db
      .prepare(
        "SELECT username, kind, expires_at FROM account_invitations WHERE token_hash=? AND expires_at>? AND accepted_at IS NULL",
      )
      .get(hash, now);
    if (!row) throw new HttpError(410, "invitation_unavailable");
    if (
      typeof row.username !== "string" ||
      (row.kind !== "invite" && row.kind !== "reset") ||
      typeof row.expires_at !== "number"
    )
      throw new Error("Invalid invitation storage");
    return {
      username: row.username,
      kind: row.kind,
      expiresAt: row.expires_at,
    };
  }
  accept(hash: string, passwordHash: string, now: number): void {
    this.transaction(() => {
      const invitation = this.inspect(hash, now);
      const row = this.db
        .prepare(
          "UPDATE account_invitations SET accepted_at=? WHERE token_hash=? AND accepted_at IS NULL RETURNING email",
        )
        .get(now, hash);
      if (!row) throw new HttpError(410, "invitation_unavailable");
      let accountId: string;
      if (invitation.kind === "invite") {
        // An operator can create the same account while the invitation is pending.
        if (
          this.db
            .prepare("SELECT 1 FROM accounts WHERE username=?")
            .get(invitation.username)
        )
          throw new HttpError(409, "username_taken");
        accountId = randomUUID();
        this.db
          .prepare(
            "INSERT INTO accounts (id,username,password_hash,local_only) VALUES (?,?,?,0)",
          )
          .run(accountId, invitation.username, passwordHash);
      } else {
        const account = this.db
          .prepare(
            "UPDATE accounts SET password_hash=? WHERE username=? AND local_only=0 RETURNING id",
          )
          .get(passwordHash, invitation.username);
        if (!account || typeof account.id !== "string")
          throw new HttpError(410, "invitation_unavailable");
        accountId = account.id;
        invalidateCredentials(this.db, accountId);
      }
    });
  }
  cancel(operator: string, username: string): void {
    if (!this.isOperator(operator))
      throw new HttpError(403, "operator_required");
    this.db
      .prepare(
        "DELETE FROM account_invitations WHERE username=? AND issued_by=? AND accepted_at IS NULL",
      )
      .run(username, operator);
  }
  removeInvitations(username: string): void {
    this.db
      .prepare("DELETE FROM account_invitations WHERE username=?")
      .run(username);
  }
}
