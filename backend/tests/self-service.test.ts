import { afterEach, beforeEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../store.ts";
import { createApi } from "../api.ts";
import { hostedConfig } from "../config.ts";
import { hashPassword, tokenHash } from "../password.ts";
import { record, text } from "../../src/classroom-contract.ts";
import { starterBoard } from "../../src/board.ts";

const origin = "https://teachers.example.test";
const password = "Synthetic teacher signup password";
const replacement = "Synthetic teacher replacement password";
let store: SqliteStore;
let api: Awaited<ReturnType<typeof createApi>>;
let directory: string;
let path: string;
let now: number;
type Actor = { cookie: string; csrf: string; recoveryCode: string };
function call(
  route: string,
  payload?: unknown,
  actor?: Actor,
  headers: Record<string, string> = {},
  peer = "peer",
) {
  return api(
    new Request(origin + "/api/auth/" + route, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(actor ? { Cookie: actor.cookie, "X-CSRF-Token": actor.csrf } : {}),
        ...headers,
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }),
    peer,
  );
}
async function actor(response: Response): Promise<Actor> {
  expect(response.status).toBeLessThan(300);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const value = record(await response.json());
  return {
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    csrf: text(value.csrfToken),
    recoveryCode:
      typeof value.recoveryCode === "string" ? value.recoveryCode : "",
  };
}
async function register(username = "teacher") {
  return actor(await call("register", { username, password }));
}
function clearLimits() {
  const db = new DatabaseSync(path);
  db.exec("DELETE FROM self_service_limits; DELETE FROM login_limits");
  db.close();
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sayboard-self-service-"));
  path = join(directory, "db.sqlite");
  store = new SqliteStore(path);
  now = Date.now();
  api = await createApi(
    store,
    { kind: "hosted", origin, signupEnabled: true, publicAccountLimit: 2 },
    () => now,
  );
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

it("creates an ordinary authenticated teacher without boards and preserves exact-case identities", async () => {
  const teacher = await register();
  const account = await store.account("teacher");
  expect(account?.localOnly).toBe(false);
  expect(store.onboarding.isOperator(account?.id ?? "")).toBe(false);
  expect(await store.board(account?.id ?? "")).toBeNull();
  expect((await call("session", undefined, teacher)).status).toBe(200);
  expect(teacher.cookie).toContain("__Host-sayboard_session=");
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT * FROM account_recovery").get();
  expect(row?.token_hash).toBe(tokenHash(teacher.recoveryCode));
  expect(JSON.stringify(row)).not.toContain(teacher.recoveryCode);
  db.close();
  await register("Teacher");
  expect((await call("register", { username: "third", password })).status).toBe(
    503,
  );
});
it("rejects privileged fields, reserved names, bad credentials and request boundaries", async () => {
  for (const input of [
    { username: "ADMIN", password },
    { username: "Teacher_0123456789abcdef", password },
    { username: "spaces here", password },
    { username: "teacher", password: "short" },
    { username: "teacher", password, localOnly: true },
    { username: "teacher", password, role: "operator" },
    { username: "teacher", password, id: "chosen-id" },
  ])
    expect((await call("register", input)).status).toBe(400);
  expect((await call("register")).status).toBe(405);
  expect(
    (
      await call("register", { username: "teacher", password }, undefined, {
        Origin: "https://evil.example",
      })
    ).status,
  ).toBe(403);
  clearLimits();
  expect(
    (await call("register", {}, undefined, { "Content-Type": "text/plain" }))
      .status,
  ).toBe(415);
  expect((await call("register", { password: "x".repeat(5000) })).status).toBe(
    413,
  );
  expect((await call("register?password=secret", {})).status).toBe(400);
  expect(await store.account("teacher")).toBeNull();
});
it("has one winner for duplicate signup and reserves live invitations", async () => {
  const responses = await Promise.all([
    call("register", { username: "teacher", password }),
    call("register", { username: "teacher", password }),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  await store.addAccount("organiser", password, false);
  store.onboarding.enableOperator("organiser");
  const operator = await store.account("organiser");
  store.onboarding.issue(
    operator!.id,
    "invited",
    null,
    "invite",
    tokenHash("invite"),
    now,
  );
  expect(
    (await call("register", { username: "invited", password })).status,
  ).toBe(409);
  now += 49 * 60 * 60_000;
  expect(
    (await call("register", { username: "invited", password })).status,
  ).toBe(201);
});
it("recovers once, rotates credentials, revokes sessions and pending resets, and preserves owner data", async () => {
  const first = await register();
  const login = await actor(
    await call("login", { username: "teacher", password }),
  );
  const account = await store.account("teacher");
  await store.saveBoard(account!.id, starterBoard(), 0);
  await store.addAccount("organiser", password, false);
  store.onboarding.enableOperator("organiser");
  const organiser = await store.account("organiser");
  store.onboarding.issue(
    organiser!.id,
    "teacher",
    null,
    "reset",
    tokenHash("reset"),
    now,
  );
  const request = {
    username: "teacher",
    password: replacement,
    recoveryCode: first.recoveryCode,
  };
  const responses = await Promise.all([
    call("recover", request),
    call("recover", request),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
  const success = responses.find((r) => r.status === 200)!;
  const recovered = await actor(success);
  expect(recovered.recoveryCode).not.toBe(first.recoveryCode);
  expect((await call("session", undefined, first)).status).toBe(401);
  expect((await call("session", undefined, login)).status).toBe(401);
  expect((await call("session", undefined, recovered)).status).toBe(200);
  expect((await call("login", { username: "teacher", password })).status).toBe(
    401,
  );
  expect(
    (await call("login", { username: "teacher", password: replacement }))
      .status,
  ).toBe(200);
  expect(() => store.onboarding.inspect(tokenHash("reset"), now)).toThrow();
  expect((await store.board(account!.id))?.revision).toBe(1);
  await register("other");
  expect(await store.board((await store.account("other"))!.id)).toBeNull();
});
it("keeps recovery available with signup disabled and rejects unsupported opt-in", async () => {
  const first = await register();
  api = await createApi(
    store,
    { kind: "hosted", origin, signupEnabled: false },
    () => now,
  );
  expect((await call("register", { username: "other", password })).status).toBe(
    403,
  );
  expect(await (await call("capabilities")).json()).toMatchObject({
    signupEnabled: false,
    recoveryEnabled: true,
  });
  expect(
    (
      await call("recover", {
        username: "teacher",
        password: replacement,
        recoveryCode: first.recoveryCode,
      })
    ).status,
  ).toBe(200);
  const env = {
    NODE_ENV: "production",
    SAYBOARD_AUTH_ENABLED: "1",
    SAYBOARD_STORAGE: "sqlite",
    SAYBOARD_DATABASE_PATH: path,
    SAYBOARD_ORIGIN: origin,
  };
  for (const extra of [
    { SAYBOARD_SIGNUP_ENABLED: "true" },
    { SAYBOARD_PUBLIC_ACCOUNT_LIMIT: "0" },
    { SAYBOARD_PUBLIC_ACCOUNT_LIMIT: "1.5" },
    {
      SAYBOARD_SIGNUP_ENABLED: "1",
      SAYBOARD_STORAGE: "postgres",
      DATABASE_URL: "postgres://unused",
    },
  ])
    expect(() => hostedConfig({ ...env, ...extra })).toThrow();
});
it("replaces kits only after CSRF and current-password verification", async () => {
  const first = await register();
  expect(
    (
      await call("recovery-kit", { password }, first, {
        "X-CSRF-Token": "wrong",
      })
    ).status,
  ).toBe(403);
  expect(
    (await call("recovery-kit", { password: replacement }, first)).status,
  ).toBe(400);
  expect((await call("session", undefined, first)).status).toBe(200);
  const result = await call("recovery-kit", { password }, first);
  expect(result.status).toBe(200);
  const kit = record(await result.json());
  expect(
    (
      await call("recover", {
        username: "teacher",
        password: replacement,
        recoveryCode: first.recoveryCode,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await call("recover", {
        username: "teacher",
        password: replacement,
        recoveryCode: text(kit.recoveryCode),
      })
    ).status,
  ).toBe(200);
});
it("invalidates kits on CLI and invitation resets and supports invited password teachers", async () => {
  const first = await register();
  await store.resetPassword("teacher", replacement);
  expect(
    (
      await call("recover", {
        username: "teacher",
        password,
        recoveryCode: first.recoveryCode,
      })
    ).status,
  ).toBe(401);
  const teacher = await actor(
    await call("login", { username: "teacher", password: replacement }),
  );
  const result = record(
    await (
      await call("recovery-kit", { password: replacement }, teacher)
    ).json(),
  );
  await store.addAccount("organiser", password, false);
  store.onboarding.enableOperator("organiser");
  const organiser = (await store.account("organiser"))!;
  store.onboarding.issue(
    organiser.id,
    "teacher",
    null,
    "reset",
    tokenHash("reset"),
    now,
  );
  store.onboarding.accept(
    tokenHash("reset"),
    await hashPassword(password),
    now,
  );
  expect(
    (
      await call("recover", {
        username: "teacher",
        password: replacement,
        recoveryCode: text(result.recoveryCode),
      })
    ).status,
  ).toBe(401);
  store.onboarding.issue(
    organiser.id,
    "invited",
    null,
    "invite",
    tokenHash("invite"),
    now,
  );
  store.onboarding.accept(
    tokenHash("invite"),
    await hashPassword(password),
    now,
  );
  const invited = await actor(
    await call("login", { username: "invited", password }),
  );
  expect((await call("recovery-kit", { password }, invited)).status).toBe(200);
  store.onboarding.enableOperator("invited");
  expect((await call("recovery-kit", { password }, invited)).status).toBe(403);
});
it("rejects stale verified hashes for both password sessions and kit replacement", async () => {
  await register();
  const old = (await store.account("teacher"))!;
  expect(
    await store.createPasswordSession(
      tokenHash("early"),
      old.id,
      old.passwordHash,
      now + 1000,
    ),
  ).toBe(true);
  await store.resetPassword("teacher", replacement);
  expect(await store.session(tokenHash("early"), now)).toBeNull();
  expect(
    await store.createPasswordSession(
      tokenHash("late"),
      old.id,
      old.passwordHash,
      now + 1000,
    ),
  ).toBe(false);
  expect(() =>
    store.selfService.replace({
      accountId: old.id,
      verifiedPasswordHash: old.passwordHash,
      recoveryHash: tokenHash("new-code"),
    }),
  ).toThrow();
  expect(await store.session(tokenHash("late"), now)).toBeNull();
});
it("bounds saturated admission counters and active peer keys across restart", async () => {
  for (let i = 0; i < 20; i++)
    expect(store.selfService.allowAttempt("school", now)).toBe(i < 10);
  for (let i = 0; i < 150; i++)
    store.selfService.allowAttempt(`peer-${i}`, now);
  store.close();
  store = new SqliteStore(path);
  expect(store.selfService.allowAttempt("fresh", now)).toBe(false);
  const db = new DatabaseSync(path);
  expect(
    db.prepare("SELECT count(*) AS count FROM self_service_limits").get()
      ?.count,
  ).toBeLessThanOrEqual(101);
  expect(
    db.prepare("SELECT max(count) AS count FROM self_service_limits").get()
      ?.count,
  ).toBe(101);
  db.close();
  expect(store.selfService.allowAttempt("school", now + 300_000)).toBe(true);
});
it("reopens an old database additively without changing existing identities or boards", async () => {
  const first = await register();
  const id = (await store.account("teacher"))!.id;
  await store.saveBoard(id, starterBoard(), 0);
  store.close();
  store = new SqliteStore(path);
  expect((await store.account("teacher"))?.id).toBe(id);
  expect((await store.board(id))?.revision).toBe(1);
  api = await createApi(store, { kind: "hosted", origin }, () => now);
  expect(
    (
      await call("recover", {
        username: "teacher",
        password: replacement,
        recoveryCode: first.recoveryCode,
      })
    ).status,
  ).toBe(200);
});

it("shares synchronous password admission with login before its account lookup resolves", async () => {
  const teacher = await register();
  api = await createApi(
    store,
    { kind: "hosted", origin, signupEnabled: true, passwordConcurrency: 1 },
    () => now,
  );
  const original = store.account.bind(store);
  let release = () => {};
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  store.account = async (username) => {
    entered();
    await waiting;
    return original(username);
  };
  const login = call("login", { username: "teacher", password });
  await started;
  try {
    for (const [route, input] of [
      ["register", { username: "other", password }],
      [
        "recover",
        { username: "teacher", password, recoveryCode: teacher.recoveryCode },
      ],
      ["recovery-kit", { password }],
    ] satisfies [string, unknown][]) {
      const response = await call(route, input, teacher);
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("300");
    }
  } finally {
    release();
  }
  expect((await login).status).toBe(200);
});
it("cannot issue a password-login session after a reset commits during login", async () => {
  await register();
  const original = store.createPasswordSession.bind(store);
  store.createPasswordSession = async (...args) => {
    await store.resetPassword("teacher", replacement);
    return original(...args);
  };
  expect((await call("login", { username: "teacher", password })).status).toBe(
    401,
  );
});
it("returns retryable public request limits and refuses Google, admin and local recovery", async () => {
  for (let i = 0; i < 10; i++)
    expect((await call("register", {})).status).toBe(400);
  const response = await call("register", {});
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("300");
  const google = store.google.account("synthetic-subject", true);
  await store.resetPassword(google.username, password);
  await store.addAccount("admin", password, false);
  await store.addAccount("local", password, true);
  for (const username of [google.username, "admin", "local"])
    expect(
      store.selfService.eligible((await store.account(username))!.id),
    ).toBe(false);
});
it("adds recovery tables to a pre-self-service database without changing stored data", async () => {
  await register();
  const account = (await store.account("teacher"))!;
  await store.saveBoard(account.id, starterBoard(), 0);
  store.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE account_recovery; DROP TABLE self_service_limits");
  legacy.close();
  store = new SqliteStore(path);
  expect(await store.account("teacher")).toEqual(account);
  expect((await store.board(account.id))?.revision).toBe(1);
  api = await createApi(store, { kind: "hosted", origin }, () => now);
  const teacher = await actor(
    await call("login", { username: "teacher", password }),
  );
  expect((await call("recovery-kit", { password }, teacher)).status).toBe(200);
});
