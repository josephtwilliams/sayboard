import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { tokenHash } from "./password.js";
import type { EmailInspection } from "../src/email-contract.js";
import { HttpError } from "./api-http.js";

export type RegistrationInput = { username: string; password: string };
export type RecoveryInput = RegistrationInput & { recoveryCode: string };
type SessionGrant = { sessionHash: string; expiresAt: number };
type Credentials = { passwordHash: string; recoveryHash: string };
type EmailSubject =
  | { kind: "signup" }
  | {
      kind: "reset";
      target: { accountId: string; credentialTag: string } | null;
    }
  | { kind: "link"; accountId: string; credentialTag: string };
type EmailGrant = { email: string; subject: EmailSubject };
type EmailRequest =
  { kind: "signup" | "reset" } | { kind: "link"; sessionHash: string };
type EmailCompletion = { tokenHash: string; now: number } & (
  | {
      kind: "signup";
      passwordHash: string;
      sessionHash: string;
      expiresAt: number;
      capacity: number;
    }
  | {
      kind: "reset";
      passwordHash: string;
      sessionHash: string;
      expiresAt: number;
    }
  | { kind: "link"; sessionHash: string; verifiedPasswordHash: string }
);
export interface SelfServiceStore {
  emailUsername(email: string): string | null;
  verifiedEmail(accountId: string): string | null;
  issueEmail(
    input: EmailRequest & {
      email: string;
      tokenHash: string;
      peer: string;
      now: number;
    },
  ): void;
  inspectEmail(hash: string, now: number): EmailInspection;
  completeEmail(input: EmailCompletion): string;
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
  db.prepare("DELETE FROM email_grants WHERE account_id=?").run(accountId);
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
    ) STRICT;
    CREATE TABLE IF NOT EXISTS account_emails (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      email_key TEXT NOT NULL UNIQUE, verified_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS email_grants (
      token_hash TEXT PRIMARY KEY, purpose TEXT NOT NULL CHECK(purpose IN ('signup','reset','link')),
      email_key TEXT NOT NULL, account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
      credential_tag TEXT, expires_at INTEGER NOT NULL,
      CHECK ((purpose='signup' AND account_id IS NULL AND credential_tag IS NULL)
        OR (purpose='reset' AND ((account_id IS NULL AND credential_tag IS NULL) OR (account_id IS NOT NULL AND credential_tag IS NOT NULL)))
        OR (purpose='link' AND account_id IS NOT NULL AND credential_tag IS NOT NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS email_grants_recipient ON email_grants(email_key,purpose,expires_at);
    CREATE INDEX IF NOT EXISTS email_grants_account ON email_grants(account_id);
    CREATE INDEX IF NOT EXISTS email_grants_expiry ON email_grants(expires_at);
    CREATE TABLE IF NOT EXISTS email_limits (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;`);
  }
  verifiedEmail(accountId: string): string | null {
    const row = this.db
      .prepare("SELECT email_key FROM account_emails WHERE account_id=?")
      .get(accountId);
    return typeof row?.email_key === "string" ? row.email_key : null;
  }
  emailUsername(email: string): string | null {
    const row = this.db
      .prepare(
        "SELECT username FROM accounts JOIN account_emails ON account_id=id WHERE email_key=?",
      )
      .get(email);
    return typeof row?.username === "string" ? row.username : null;
  }
  issueEmail(
    input: EmailRequest & {
      email: string;
      tokenHash: string;
      peer: string;
      now: number;
    },
  ): void {
    const admitted = this.transaction(() => {
      this.db
        .prepare("DELETE FROM email_limits WHERE expires_at<=?")
        .run(input.now);
      this.db
        .prepare("DELETE FROM email_grants WHERE expires_at<=?")
        .run(input.now);
      const recipient = tokenHash(input.email);
      const budgets = [
        { key: "host", limit: 100, duration: 300_000 },
        { key: `peer:${input.peer}`, limit: 10, duration: 300_000 },
        { key: `recipient:${recipient}`, limit: 3, duration: 3_600_000 },
        { key: `cooldown:${recipient}`, limit: 1, duration: 60_000 },
      ];
      const keys = this.db
        .prepare("SELECT count(*) AS n FROM email_limits")
        .get();
      const missing = budgets.filter(
        (b) =>
          !this.db.prepare("SELECT 1 FROM email_limits WHERE key=?").get(b.key),
      ).length;
      if (Number(keys?.n) + missing > 2048) return false;
      // Reserve all budgets even when one is exhausted. Failed delivery never refunds them.
      let allowed = true;
      for (const b of budgets) {
        const row = this.db
          .prepare(
            `INSERT INTO email_limits VALUES (?,1,?)
          ON CONFLICT(key) DO UPDATE SET count=min(count+1,?) RETURNING count`,
          )
          .get(b.key, input.now + b.duration, b.limit + 1);
        if (Number(row?.count) > b.limit) allowed = false;
      }
      if (!allowed) return false;
      const live = this.db
        .prepare(
          "SELECT count(*) AS n FROM email_grants WHERE email_key=? AND purpose=?",
        )
        .get(input.email, input.kind);
      const total = this.db
        .prepare("SELECT count(*) AS n FROM email_grants")
        .get();
      if (Number(live?.n) >= 3 || Number(total?.n) >= 1000) return false;
      let accountId: string | null = null;
      let credentialTag: string | null = null;
      const account =
        input.kind === "link"
          ? this.db
              .prepare(
                "SELECT accounts.* FROM accounts JOIN sessions ON account_id=id WHERE token_hash=? AND expires_at>?",
              )
              .get(input.sessionHash, input.now)
          : input.kind === "reset"
            ? this.db
                .prepare(
                  "SELECT accounts.* FROM accounts JOIN account_emails ON account_id=id WHERE email_key=?",
                )
                .get(input.email)
            : undefined;
      if (
        account &&
        typeof account.id === "string" &&
        typeof account.password_hash === "string" &&
        this.eligible(account.id)
      ) {
        accountId = account.id;
        credentialTag = tokenHash(account.password_hash);
      }
      if (
        input.kind === "link" &&
        (!accountId || this.verifiedEmail(accountId))
      )
        throw new HttpError(409, "email_link_unavailable");
      this.db
        .prepare("INSERT INTO email_grants VALUES (?,?,?,?,?,?)")
        .run(
          input.tokenHash,
          input.kind,
          input.email,
          accountId,
          credentialTag,
          input.now + 30 * 60_000,
        );
      return true;
    });
    if (!admitted)
      throw new HttpError(429, "too_many_attempts", { "Retry-After": "300" });
  }
  private emailGrant(hash: string, now: number): EmailGrant | null {
    const row = this.db
      .prepare("SELECT * FROM email_grants WHERE token_hash=? AND expires_at>?")
      .get(hash, now);
    if (!row || typeof row.email_key !== "string") return null;
    const email = row.email_key;
    if (row.purpose === "signup") return { email, subject: { kind: "signup" } };
    if (row.purpose === "reset" && row.account_id === null)
      return { email, subject: { kind: "reset", target: null } };
    if (
      (row.purpose !== "reset" && row.purpose !== "link") ||
      typeof row.account_id !== "string" ||
      typeof row.credential_tag !== "string"
    )
      throw new Error("Invalid email grant");
    const target = {
      accountId: row.account_id,
      credentialTag: row.credential_tag,
    };
    return {
      email,
      subject:
        row.purpose === "link"
          ? { kind: "link", ...target }
          : { kind: "reset", target },
    };
  }
  inspectEmail(hash: string, now: number): EmailInspection {
    const grant = this.emailGrant(hash, now);
    if (!grant) return { kind: "unavailable" };
    const { subject, email } = grant;
    if (subject.kind === "signup")
      return this.emailUsername(email)
        ? { kind: "unavailable" }
        : { kind: "signup", email };
    const target = subject.kind === "reset" ? subject.target : subject;
    if (!target || !this.eligible(target.accountId))
      return { kind: "unavailable" };
    const account = this.db
      .prepare("SELECT username,password_hash FROM accounts WHERE id=?")
      .get(target.accountId);
    if (
      typeof account?.password_hash !== "string" ||
      typeof account.username !== "string" ||
      tokenHash(account.password_hash) !== target.credentialTag
    )
      return { kind: "unavailable" };
    if (subject.kind === "reset")
      return this.verifiedEmail(target.accountId) === email
        ? { kind: "reset", email }
        : { kind: "unavailable" };
    return this.verifiedEmail(target.accountId) || this.emailUsername(email)
      ? { kind: "unavailable" }
      : { kind: "link", email, username: account.username };
  }
  completeEmail(input: EmailCompletion): string {
    return this.transaction(() => {
      const view = this.inspectEmail(input.tokenHash, input.now);
      const grant = this.emailGrant(input.tokenHash, input.now);
      if (!grant || view.kind !== input.kind)
        throw new HttpError(400, "email_link_unavailable");
      const subject = grant.subject;
      let id: string;
      let username: string;
      if (input.kind === "signup" && subject.kind === "signup") {
        const count = this.db
          .prepare(
            "SELECT count(*) AS n FROM account_recovery WHERE public_signup=1",
          )
          .get();
        if (Number(count?.n) >= input.capacity)
          throw new HttpError(503, "signup_capacity_reached");
        id = randomUUID();
        username = `teacher_${randomUUID().replaceAll("-", "")}`;
        for (
          let attempt = 0;
          this.db
            .prepare(
              "SELECT 1 FROM accounts WHERE username=? UNION ALL SELECT 1 FROM account_invitations WHERE username=? AND accepted_at IS NULL AND expires_at>?",
            )
            .get(username, username, input.now);
          attempt++
        ) {
          if (attempt >= 3) throw new HttpError(503, "signup_capacity_reached");
          username = `teacher_${randomUUID().replaceAll("-", "")}`;
        }
        this.db
          .prepare("INSERT INTO accounts VALUES (?,?,?,0)")
          .run(id, username, input.passwordHash);
        this.db
          .prepare("INSERT INTO account_recovery VALUES (?,NULL,1)")
          .run(id);
      } else {
        const target =
          subject.kind === "reset"
            ? subject.target
            : subject.kind === "link"
              ? subject
              : null;
        if (!target) throw new HttpError(400, "email_link_unavailable");
        id = target.accountId;
        const row = this.db
          .prepare("SELECT username FROM accounts WHERE id=?")
          .get(id);
        if (typeof row?.username !== "string")
          throw new Error("Invalid email account");
        username = row.username;
        if (input.kind === "link") {
          if (
            tokenHash(input.verifiedPasswordHash) !== target.credentialTag ||
            !this.db
              .prepare(
                "SELECT 1 FROM sessions WHERE token_hash=? AND account_id=? AND expires_at>?",
              )
              .get(input.sessionHash, id, input.now)
          )
            throw new HttpError(400, "email_link_unavailable");
        } else if (input.kind === "reset") {
          invalidateCredentials(this.db, id);
          this.db
            .prepare("UPDATE accounts SET password_hash=? WHERE id=?")
            .run(input.passwordHash, id);
        }
      }
      if (input.kind !== "reset")
        this.db
          .prepare("INSERT INTO account_emails VALUES (?,?,?)")
          .run(id, grant.email, input.now);
      this.db
        .prepare(
          "DELETE FROM email_grants WHERE account_id=? OR (email_key=? AND purpose='signup')",
        )
        .run(id, grant.email);
      if (input.kind !== "link")
        this.db
          .prepare("INSERT INTO sessions VALUES (?,?,?)")
          .run(input.sessionHash, id, input.expiresAt);
      return username;
    });
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
