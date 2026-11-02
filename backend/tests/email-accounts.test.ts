import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../store.ts";
import { createApi } from "../api.ts";
import type { AccountMail, Mailer } from "../mail.ts";
import { starterBoard } from "../../src/board.ts";
import { record, text } from "../../src/classroom-contract.ts";
const origin = "https://email.example.test";
const password = "Synthetic teacher email password";
let store: SqliteStore;
let db: DatabaseSync;
let api: Awaited<ReturnType<typeof createApi>>;
let directory: string;
let now: number;
let sent: AccountMail[];
let mail: Mailer;
const config = {
  kind: "hosted",
  origin,
  signupEnabled: true,
  teacherAccountMode: "verified-email",
  publicAccountLimit: 2,
} as const;
type Actor = { cookie: string; csrf: string; username: string };
async function call(route: string, input?: unknown, actor?: Actor) {
  return api(
    new Request(origin + "/api/auth/" + route, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(actor ? { Cookie: actor.cookie, "X-CSRF-Token": actor.csrf } : {}),
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    }),
    "peer",
  );
}
async function actor(response: Response): Promise<Actor> {
  expect(response.status).toBeLessThan(300);
  const value = record(await response.json());
  expect(value.recoveryCode).toBeUndefined();
  return {
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    csrf: text(value.csrfToken),
    username: text(record(value.account).username),
  };
}
function token(index = sent.length - 1) {
  return new URL(sent[index].url).hash.slice(7);
}
async function issue(kind: "signup" | "reset", email = "teacher@example.test") {
  const result = await call("email/request", { kind, email });
  expect(result.status).toBe(202);
  expect(await result.json()).toEqual({
    kind: "requested",
    retryAfterSeconds: 60,
  });
  return token();
}
async function signup(email = "teacher@example.test") {
  return actor(
    await call("email/complete", {
      kind: "signup",
      token: await issue("signup", email),
      password,
    }),
  );
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sayboard-email-"));
  store = new SqliteStore(join(directory, "db.sqlite"));
  db = new DatabaseSync(join(directory, "db.sqlite"));
  now = Date.now();
  sent = [];
  mail = {
    async send(message) {
      if (message.kind === "email") sent.push(message);
    },
    async verify() {},
  };
  api = await createApi(store, config, () => now, mail);
});
afterEach(() => {
  db.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it("defers accounts, scrubs public responses, inspects read-only and completes once without a kit", async () => {
  const proof = await issue("signup", " Teacher@Example.test ");
  expect(db.prepare("SELECT count(*) AS n FROM accounts").get()?.n).toBe(0);
  expect(
    JSON.stringify(db.prepare("SELECT * FROM email_grants").all()),
  ).not.toContain(proof);
  for (let i = 0; i < 2; i++)
    expect(
      await (await call("email/inspect", { token: proof })).json(),
    ).toEqual({ kind: "signup", email: "teacher@example.test" });
  expect(
    (await call("email/complete", { kind: "reset", token: proof, password }))
      .status,
  ).toBe(400);
  const user = await actor(
    await call("email/complete", { kind: "signup", token: proof, password }),
  );
  expect(user.username).toMatch(/^teacher_[a-f0-9]{32}$/);
  expect(
    db.prepare("SELECT token_hash FROM account_recovery").get()?.token_hash,
  ).toBeNull();
  expect(
    (await call("email/complete", { kind: "signup", token: proof, password }))
      .status,
  ).toBe(400);
  expect(
    (await call("login", { username: "TEACHER@example.test", password }))
      .status,
  ).toBe(200);
  expect(
    (await call("register", { username: "bypass", password })).status,
  ).toBe(403);
});
it("keeps earlier resends live, sends neutral duplicate/unknown actions, bounds fourth requests", async () => {
  const first = await issue("signup");
  now += 61_000;
  await issue("signup");
  now += 61_000;
  await issue("signup");
  now += 61_000;
  expect(
    (
      await call("email/request", {
        kind: "signup",
        email: "teacher@example.test",
      })
    ).status,
  ).toBe(429);
  expect(sent).toHaveLength(3);
  await actor(
    await call("email/complete", { kind: "signup", token: first, password }),
  );
  expect(db.prepare("SELECT count(*) AS n FROM email_grants").get()?.n).toBe(0);
  now += 3_600_000;
  const duplicate = await issue("signup");
  expect(
    await (await call("email/inspect", { token: duplicate })).json(),
  ).toEqual({ kind: "unavailable" });
  const unknown = await issue("reset", "unknown@example.test");
  now += 61_000;
  await signup("unknown@example.test");
  expect(
    (await call("email/complete", { kind: "reset", token: unknown, password }))
      .status,
  ).toBe(400);
});
it("preserves ambiguous deliveries and does not refund limits", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const capture = mail.send;
  mail.send = async (message) => {
    await capture(message);
    throw new Error("private SMTP error");
  };
  const proof = await issue("signup");
  expect(
    (
      await call("email/request", {
        kind: "signup",
        email: "teacher@example.test",
      })
    ).status,
  ).toBe(429);
  await actor(
    await call("email/complete", { kind: "signup", token: proof, password }),
  );
  expect(console.error).toHaveBeenCalledWith(
    '{"event":"email_delivery_failed"}',
  );
});
it("rolls back account/proof/session on insertion failure and capacity races", async () => {
  const first = await issue("signup");
  db.exec(
    "CREATE TRIGGER reject_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  );
  expect(
    (await call("email/complete", { kind: "signup", token: first, password }))
      .status,
  ).toBe(503);
  expect(db.prepare("SELECT count(*) AS n FROM accounts").get()?.n).toBe(0);
  db.exec("DROP TRIGGER reject_session");
  await actor(
    await call("email/complete", { kind: "signup", token: first, password }),
  );
  const a = await issue("signup", "a@example.test"),
    b = await issue("signup", "b@example.test");
  const results = await Promise.all(
    [a, b].map((token) =>
      call("email/complete", { kind: "signup", token, password }),
    ),
  );
  expect(results.map((r) => r.status).sort()).toEqual([200, 503]);
  expect(db.prepare("SELECT count(*) AS n FROM accounts").get()?.n).toBe(2);
  expect(db.prepare("SELECT count(*) AS n FROM email_grants").get()?.n).toBe(1);
});
it("requires same-account session, CSRF and current password for linking; initiating session need not survive", async () => {
  await store.addAccount("legacy", password, false);
  await store.addAccount("other", password, false);
  const user = await actor(
    await call("login", { username: "legacy", password }),
  );
  const other = await actor(
    await call("login", { username: "other", password }),
  );
  expect(
    (
      await call(
        "email/link",
        { email: "legacy@example.test" },
        { ...user, csrf: "bad" },
      )
    ).status,
  ).toBe(403);
  expect(
    (await call("email/link", { email: "legacy@example.test" }, user)).status,
  ).toBe(202);
  const proof = token();
  expect(await (await call("email/inspect", { token: proof })).json()).toEqual({
    kind: "link",
    email: "legacy@example.test",
    username: "legacy",
  });
  expect(
    (await call("email/complete", { kind: "link", token: proof, password }))
      .status,
  ).toBe(401);
  expect(
    (
      await call(
        "email/complete",
        { kind: "link", token: proof, password },
        other,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        "email/complete",
        { kind: "link", token: proof, password: "Incorrect long password" },
        user,
      )
    ).status,
  ).toBe(400);
  await call("logout", {}, user);
  const fresh = await actor(
    await call("login", { username: "legacy", password }),
  );
  expect(
    (
      await call(
        "email/complete",
        { kind: "link", token: proof, password },
        fresh,
      )
    ).status,
  ).toBe(200);
  expect(store.selfService.emailUsername("legacy@example.test")).toBe("legacy");
  expect(
    (await call("login", { username: "legacy@example.test", password })).status,
  ).toBe(200);
});
it("reset revokes sessions, kits and sibling grants while preserving boards and rejecting stale login", async () => {
  const user = await signup();
  const account = await store.account(user.username);
  if (!account) throw new Error("Missing account");
  now += 61_000;
  const proof = await issue("reset");
  now += 61_000;
  await issue("reset");
  store.selfService.replace({
    accountId: account.id,
    verifiedPasswordHash: account.passwordHash,
    recoveryHash: "old-kit",
  });
  await store.saveBoard(account.id, starterBoard(), 0);
  const saved = await store.board(account.id);
  const replacement = await actor(
    await call("email/complete", {
      kind: "reset",
      token: proof,
      password: password + "new",
    }),
  );
  expect((await call("session", undefined, user)).status).toBe(401);
  expect((await call("session", undefined, replacement)).status).toBe(200);
  expect(await store.board(account.id)).toEqual(saved);
  expect(
    await store.createPasswordSession(
      "stale",
      account.id,
      account.passwordHash,
      now + 10000,
    ),
  ).toBe(false);
  expect(
    db.prepare("SELECT token_hash FROM account_recovery").get()?.token_hash,
  ).toBeNull();
  expect(db.prepare("SELECT count(*) AS n FROM email_grants").get()?.n).toBe(0);
});
it("expires proofs and invalidates grants through CLI, operator and recovery-kit password changes", async () => {
  const user = await signup();
  const account = await store.account(user.username);
  if (!account) throw new Error("Missing account");
  now += 61_000;
  await issue("reset");
  await store.resetPassword(user.username, password + "changed");
  expect(db.prepare("SELECT count(*) AS n FROM email_grants").get()?.n).toBe(0);
  now += 61_000;
  await issue("reset");
  store.selfService.replace({
    accountId: account.id,
    verifiedPasswordHash: (await store.account(user.username))!.passwordHash,
    recoveryHash: "kit",
  });
  store.selfService.recover({
    username: user.username,
    previousRecoveryHash: "kit",
    passwordHash: account.passwordHash,
    recoveryHash: "next",
    sessionHash: "session",
    expiresAt: now + 10000,
  });
  expect(db.prepare("SELECT count(*) AS n FROM email_grants").get()?.n).toBe(0);
  now += 3_600_000;
  const proof = await issue("reset");
  now += 30 * 60_000;
  expect(await (await call("email/inspect", { token: proof })).json()).toEqual({
    kind: "unavailable",
  });
});
it("persists mail limits across restart and isolates saturated email keys from legacy recovery", async () => {
  await issue("signup");
  store.close();
  store = new SqliteStore(join(directory, "db.sqlite"));
  expect(() =>
    store.selfService.issueEmail({
      kind: "reset",
      email: "teacher@example.test",
      tokenHash: "another",
      peer: "peer",
      now,
    }),
  ).toThrow();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO email_limits VALUES (?,1,?)",
  );
  for (let i = 0; i < 2048; i++) insert.run(`synthetic:${i}`, now + 60_000);
  expect(() =>
    store.selfService.issueEmail({
      kind: "signup",
      email: "fresh@example.test",
      tokenHash: "fresh",
      peer: "fresh",
      now,
    }),
  ).toThrow();
  expect(store.selfService.allowAttempt("legacy", now)).toBe(true);
});
it("closes signup without SMTP but keeps existing email login and kit recovery available", async () => {
  const user = await signup();
  api = await createApi(store, config, () => now, null);
  const caps = await (await call("capabilities")).json();
  expect(caps).toMatchObject({
    signupEnabled: false,
    recoveryEnabled: true,
    emailAvailability: "unavailable",
  });
  expect(
    (await call("register", { username: "bypass", password })).status,
  ).toBe(403);
  expect(
    (
      await call("email/request", {
        kind: "reset",
        email: "teacher@example.test",
      })
    ).status,
  ).toBe(503);
  expect(
    (await call("login", { username: "teacher@example.test", password }))
      .status,
  ).toBe(200);
  api = await createApi(
    store,
    { ...config, signupEnabled: false },
    () => now,
    mail,
  );
  now += 61_000;
  await issue("reset");
  expect(
    (await call("email/request", { kind: "signup", email: "new@example.test" }))
      .status,
  ).toBe(403);
  expect(user.username).toBeTruthy();
});

it("serializes duplicate completion and prevents link-request CSRF bypass through the public route", async () => {
  const proof = await issue("signup");
  const results = await Promise.all(
    [1, 2].map(() =>
      call("email/complete", { kind: "signup", token: proof, password }),
    ),
  );
  expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  expect(db.prepare("SELECT count(*) AS n FROM sessions").get()?.n).toBe(1);
  await store.addAccount("legacy", password, false);
  const user = await actor(
    await call("login", { username: "legacy", password }),
  );
  expect(
    (
      await call(
        "email/request",
        { kind: "link", email: "victim@example.test" },
        { ...user, csrf: "" },
      )
    ).status,
  ).toBe(400);
  expect(store.selfService.emailUsername("victim@example.test")).toBeNull();
});
it("rechecks link authority after logout, password reset and operator promotion", async () => {
  await store.addAccount("legacy", password, false);
  const account = await store.account("legacy");
  if (!account) throw new Error("Missing account");
  const user = await actor(
    await call("login", { username: "legacy", password }),
  );
  await call("email/link", { email: "legacy@example.test" }, user);
  const proof = token();
  await call("logout", {}, user);
  expect(
    (
      await call(
        "email/complete",
        { kind: "link", token: proof, password },
        user,
      )
    ).status,
  ).toBe(401);
  expect(() =>
    store.selfService.issueEmail({
      kind: "link",
      sessionHash: "stale-session",
      tokenHash: "late-proof",
      email: "late@example.test",
      peer: "peer",
      now,
    }),
  ).toThrow();
  const fresh = await actor(
    await call("login", { username: "legacy", password }),
  );
  db.prepare("INSERT INTO account_operators VALUES (?)").run(account.id);
  expect(
    (
      await call(
        "email/complete",
        { kind: "link", token: proof, password },
        fresh,
      )
    ).status,
  ).toBe(401);
  db.prepare("DELETE FROM account_operators WHERE account_id=?").run(
    account.id,
  );
  await store.resetPassword("legacy", password + "new");
  expect(store.selfService.inspectEmail("late-proof", now)).toEqual({
    kind: "unavailable",
  });
  expect(db.prepare("SELECT count(*) AS n FROM email_grants").get()?.n).toBe(0);
});
it("keeps identity unique when two teachers link the same mailbox and invalidates sibling links", async () => {
  await store.addAccount("first", password, false);
  await store.addAccount("second", password, false);
  const first = await actor(
    await call("login", { username: "first", password }),
  );
  const second = await actor(
    await call("login", { username: "second", password }),
  );
  await call("email/link", { email: "shared@example.test" }, first);
  const a = token();
  now += 61_000;
  await call("email/link", { email: "shared@example.test" }, second);
  const b = token();
  await call("email/link", { email: "sibling@example.test" }, first);
  const sibling = token();
  const results = await Promise.all(
    [
      { proof: a, user: first },
      { proof: b, user: second },
    ].map(({ proof, user }) =>
      call("email/complete", { kind: "link", token: proof, password }, user),
    ),
  );
  expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  expect(db.prepare("SELECT count(*) AS n FROM account_emails").get()?.n).toBe(
    1,
  );
  if (store.selfService.emailUsername("shared@example.test") === "first") {
    expect(
      (
        await call(
          "email/complete",
          { kind: "link", token: sibling, password },
          first,
        )
      ).status,
    ).toBe(400);
  }
  expect((await call("session", undefined, first)).status).toBe(200);
  expect((await call("session", undefined, second)).status).toBe(200);
});
it("operator reset invalidates mailbox grants and email reset invalidates operator reset grants", async () => {
  const user = await signup();
  await store.addAccount("operator", password, false);
  const operator = await store.account("operator");
  if (!operator) throw new Error("Missing operator");
  db.prepare("INSERT INTO account_operators VALUES (?)").run(operator.id);
  now += 61_000;
  await issue("reset");
  store.onboarding.issue(
    operator.id,
    user.username,
    null,
    "reset",
    "operator-proof",
    now,
  );
  const account = await store.account(user.username);
  if (!account) throw new Error("Missing account");
  store.onboarding.accept("operator-proof", account.passwordHash, now);
  expect(db.prepare("SELECT count(*) AS n FROM email_grants").get()?.n).toBe(0);
  now += 61_000;
  const proof = await issue("reset");
  store.onboarding.issue(
    operator.id,
    user.username,
    null,
    "reset",
    "operator-proof-two",
    now,
  );
  await actor(
    await call("email/complete", {
      kind: "reset",
      token: proof,
      password: password + "new",
    }),
  );
  expect(() => store.onboarding.inspect("operator-proof-two", now)).toThrow();
});
