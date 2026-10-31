import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Console } from "node:console";
import { createHostedHandler as rawHostedHandler } from "../hosted.ts";
function createHostedHandler(...args: Parameters<typeof rawHostedHandler>) {
  const handler = rawHostedHandler(...args);
  return (request: Request, peer = "203.0.113.10") => handler(request, peer);
}
import { hostedConfig } from "../config.ts";
import { PostgresStore } from "../postgres-store.ts";
import { hashPassword, tokenHash } from "../password.ts";
import { starterBoard } from "../../src/board.ts";
import type { Account, Store } from "../store-contract.ts";

const origin = "https://sayboard.example.test";
const env = () => ({
  NODE_ENV: "production",
  SAYBOARD_AUTH_ENABLED: "1",
  SAYBOARD_STORAGE: "postgres",
  SAYBOARD_ORIGIN: origin,
  DATABASE_URL: "postgresql://synthetic:unused@db.example.test/synthetic",
});
const db = new PGlite();
const store = new PostgresStore((sql, params) => db.query(sql, params));
const password = "synthetic-test-password-only";
const owner = randomUUID();
const other = randomUUID();
let passwordHash: string;
let clock = 1_900_000_000_000;
let handler: ReturnType<typeof createHostedHandler>;
let stderr = "";
beforeAll(async () => {
  await db.exec(
    readFileSync(
      new URL("../migrations/001_postgres.sql", import.meta.url),
      "utf8",
    ),
  );
  await db.exec(
    readFileSync(
      new URL("../migrations/002_board_categories.sql", import.meta.url),
      "utf8",
    ),
  );
  passwordHash = await hashPassword(password);
}, 20_000);
beforeEach(async () => {
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  vi.spyOn(console, "error").mockImplementation(
    new Console(process.stdout, process.stderr).error,
  );
  await db.exec(
    "TRUNCATE sayboard.accounts, sayboard.sessions, sayboard.boards, sayboard.login_limits CASCADE",
  );
  for (const [id, username] of [
    [owner, "caregiver"],
    [other, "second"],
  ])
    await db.query(
      "INSERT INTO sayboard.accounts(id, username, password_hash) VALUES ($1, $2, $3)",
      [id, username, passwordHash],
    );
  clock = 1_900_000_000_000;
  handler = createHostedHandler(
    env(),
    async () => store,
    () => clock,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await db.close();
});

function request(
  path = "/api/auth/session",
  method = "GET",
  data?: unknown,
  headers: HeadersInit = {},
) {
  return new Request(origin + path, {
    method,
    headers: {
      host: new URL(origin).host,
      "x-forwarded-host": new URL(origin).host,
      "x-forwarded-proto": "https",
      ...(method !== "GET"
        ? { origin, "content-type": "application/json" }
        : {}),
      ...headers,
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
}
async function login(username = "caregiver") {
  const response = await handler(
    request("/api/auth/login", "POST", { username, password }),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!;
  const data = (await response.json()) as {
    account: { username: string };
    csrfToken: string;
    expiresAt: number;
  };
  return {
    cookie: cookie.split(";")[0],
    fullCookie: cookie,
    csrf: data.csrfToken,
    data,
  };
}

describe("hosted HTTPS boundary", () => {
  it("requires explicit complete production configuration and exact HTTPS domains", () => {
    expect(hostedConfig(env())).toEqual({
      kind: "hosted",
      origin,
      passwordConcurrency: 2,
    });
    expect(
      hostedConfig({ ...env(), SAYBOARD_PASSWORD_CONCURRENCY: "1" })
        .passwordConcurrency,
    ).toBe(1);
    for (const invalid of ["0", "3", "", "1.5"])
      expect(() =>
        hostedConfig({ ...env(), SAYBOARD_PASSWORD_CONCURRENCY: invalid }),
      ).toThrow();
    for (const variable of Object.keys(env())) {
      const incomplete: NodeJS.ProcessEnv = env();
      delete incomplete[variable];
      expect(() => hostedConfig(incomplete)).toThrow();
    }
    for (const change of [
      { NODE_ENV: "development" },
      { SAYBOARD_AUTH_ENABLED: "0" },
      { SAYBOARD_LOCAL_DEV: "1" },
    ])
      expect(() => hostedConfig({ ...env(), ...change })).toThrow();
    for (const bad of [
      "http://example.test",
      "https://user:password@example.test",
      "https://example.test/path",
      "https://example.test?x=1",
      "https://example.test#x",
      "https://example.test.",
    ])
      expect(() => hostedConfig({ ...env(), SAYBOARD_ORIGIN: bad })).toThrow();
  });
  it("fails closed without configuration before touching storage", async () => {
    const getStore = vi.fn(async () => store);
    for (const config of [{}, { ...env(), SAYBOARD_AUTH_ENABLED: "0" }]) {
      const disabled = createHostedHandler(config, getStore);
      for (const path of [
        "/api/auth/login",
        "/api/auth/session",
        "/api/auth/logout",
        "/api/board",
      ]) {
        const response = await disabled(request(path));
        expect(response.status).toBe(503);
        expect(response.headers.get("set-cookie")).toBeNull();
      }
    }
    expect(getStore).not.toHaveBeenCalled();
    expect(stderr).toBe("");
  });
  it("rejects URL, Host, forwarded origin and cross-site mutations before storage", async () => {
    const getStore = vi.fn(async () => store);
    const guarded = createHostedHandler(env(), getStore);
    const cases = [
      new Request("https://attacker.example.test/api/auth/session", {
        headers: { "x-forwarded-for": "203.0.113.10" },
      }),
      new Request("http://sayboard.example.test/api/auth/session", {
        headers: { "x-forwarded-for": "203.0.113.10" },
      }),
      request(undefined, "GET", undefined, { host: "attacker.example.test" }),
      request(undefined, "GET", undefined, {
        "x-forwarded-host": "attacker.example.test",
      }),
      request(undefined, "GET", undefined, { "x-forwarded-proto": "http" }),
      request(undefined, "GET", undefined, {
        origin: "https://attacker.example.test",
      }),
      request("/api/auth/login", "POST", {}, { origin: "null" }),
      request(
        "/api/auth/login",
        "POST",
        {},
        { "sec-fetch-site": "cross-site" },
      ),
    ];
    const missing = request("/api/auth/login", "POST", {});
    missing.headers.delete("origin");
    cases.push(missing);
    for (const req of cases) expect((await guarded(req)).status).toBe(403);
    expect(getStore).not.toHaveBeenCalled();
    expect(stderr).toBe("");
  });
  it("requires an adapter-validated client IP and ignores untrusted forwarded IPs", async () => {
    const getStore = vi.fn(async () => store);
    const guarded = createHostedHandler(env(), getStore);
    for (const value of ["", "unknown", "203.0.113.10, 203.0.113.11"])
      expect((await guarded(request(), value)).status).toBe(503);
    expect(getStore).not.toHaveBeenCalled();
    const response = await guarded(
      request(
        "/api/auth/login",
        "POST",
        { username: "caregiver", password },
        { "x-forwarded-for": "198.51.100.44" },
      ),
    );
    expect(response.status).toBe(200);
    const keys = (
      await db.query<{ key: string }>("SELECT key FROM sayboard.login_limits")
    ).rows;
    expect(keys).toEqual([{ key: tokenHash("sayboard-peer:203.0.113.10") }]);
  });
  it("issues separate Secure host cookie, validates session, revokes logout and expires", async () => {
    const user = await login();
    expect(user.fullCookie).toMatch(/^__Host-sayboard_session=[a-f0-9]{64};/);
    for (const attr of [
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=28800",
      "Secure",
    ])
      expect(user.fullCookie).toContain(attr);
    expect(user.fullCookie).not.toMatch(/Domain=/i);
    expect(user.data.account).toEqual({ username: "caregiver" });
    expect(
      (
        await handler(
          request(undefined, "GET", undefined, { cookie: user.cookie }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handler(
          request(undefined, "GET", undefined, {
            cookie: user.cookie.replace("__Host-", ""),
          }),
        )
      ).status,
    ).toBe(401);
    const logout = await handler(
      request(
        "/api/auth/logout",
        "POST",
        {},
        { cookie: user.cookie, "x-csrf-token": user.csrf },
      ),
    );
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0; Secure");
    expect(
      (
        await handler(
          request(undefined, "GET", undefined, { cookie: user.cookie }),
        )
      ).status,
    ).toBe(401);
    const renewed = await login();
    clock = renewed.data.expiresAt;
    const expired = await handler(
      request(undefined, "GET", undefined, { cookie: renewed.cookie }),
    );
    expect(expired.status).toBe(401);
    expect(expired.headers.get("set-cookie")).toContain("Max-Age=0; Secure");
  });
  it("binds CSRF and board ownership to each authenticated account", async () => {
    const a = await login();
    const b = await login("second");
    const board = starterBoard();
    for (const csrf of ["", "wrong", b.csrf])
      expect(
        (
          await handler(
            request(
              "/api/board",
              "PUT",
              { board, revision: 0 },
              { cookie: a.cookie, "x-csrf-token": csrf },
            ),
          )
        ).status,
      ).toBe(403);
    expect(
      (
        await handler(
          request(
            "/api/auth/logout",
            "POST",
            {},
            { cookie: a.cookie, "x-csrf-token": b.csrf },
          ),
        )
      ).status,
    ).toBe(403);
    const saved = await handler(
      request(
        "/api/board",
        "PUT",
        { board, revision: 0, accountId: other },
        { cookie: a.cookie, "x-csrf-token": a.csrf },
      ),
    );
    expect(await saved.json()).toEqual({ board, revision: 1 });
    expect(
      await (
        await handler(
          request("/api/board", "GET", undefined, { cookie: b.cookie }),
        )
      ).json(),
    ).toEqual({ board: null, revision: 0 });
    expect(
      (
        await handler(
          request(
            "/api/board",
            "PUT",
            { board, revision: 0 },
            { cookie: a.cookie, "x-csrf-token": a.csrf },
          ),
        )
      ).status,
    ).toBe(409);
    const changed = { ...board, voice: "synthetic-second" };
    expect(
      (
        await handler(
          request(
            "/api/board",
            "PUT",
            { board: changed, revision: 0 },
            { cookie: b.cookie, "x-csrf-token": b.csrf },
          ),
        )
      ).status,
    ).toBe(200);
    expect((await store.board(owner))?.board).toEqual(board);
    expect((await store.board(other))?.board).toEqual(changed);
  });
  it("rejects local and admin identities at login and session even with a faulty store", async () => {
    const base = (await store.account("caregiver"))!;
    for (const account of [
      { ...base, localOnly: true },
      { ...base, username: "ADMIN" },
    ]) {
      const faulty: Store = {
        account: async () => account,
        session: async () => ({ account, expiresAt: clock + 1000 }),
        createSession: vi.fn(),
        deleteSession: vi.fn(),
        board: vi.fn(),
        saveBoard: vi.fn(),
        allowLogin: async () => true,
      };
      const api = createHostedHandler(
        env(),
        async () => faulty,
        () => clock,
      );
      expect(
        (
          await api(
            request("/api/auth/login", "POST", {
              username: account.username,
              password,
            }),
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await api(
            request(undefined, "GET", undefined, {
              cookie: `__Host-sayboard_session=${"a".repeat(64)}`,
            }),
          )
        ).status,
      ).toBe(401);
      expect(faulty.createSession).not.toHaveBeenCalled();
      expect(faulty.board).not.toHaveBeenCalled();
    }
    const short: Account = {
      ...base,
      passwordHash: await hashPassword("admin"),
    };
    const api = createHostedHandler(env(), async () => ({
      session: async () => null,
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      board: vi.fn(),
      saveBoard: vi.fn(),
      account: async () => short,
      allowLogin: async () => true,
    }));
    expect(
      (
        await api(
          request("/api/auth/login", "POST", {
            username: "caregiver",
            password: "admin",
          }),
        )
      ).status,
    ).toBe(401);
  });
  it("keeps unauthenticated, validation and expected unavailable responses silent", async () => {
    for (const [req, status, error] of [
      [request(), 401, "unauthenticated"],
      [
        request("/api/auth/session?secret=synthetic"),
        400,
        "query_not_supported",
      ],
      [request("/api/auth/login", "POST", {}), 400, "invalid_credentials"],
      [
        request("/api/auth/activation", "POST", {}),
        503,
        "onboarding_unavailable",
      ],
      [
        new Request(origin + "/api/auth/login", {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: "{synthetic-invalid-json",
        }),
        400,
        "invalid_json",
      ],
    ] satisfies [Request, number, string][]) {
      const response = await handler(req);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    }
    expect(stderr).toBe("");
  });
  it.each([false, true])(
    "consumes request failures once and recovers when the log sink throws: %s",
    async (sinkThrows) => {
      const user = await login();
      const failure = {
        toString() {
          throw new Error("synthetic exception must not be inspected");
        },
      };
      vi.spyOn(store, "board").mockRejectedValueOnce(failure);
      const sink = sinkThrows
        ? vi.spyOn(console, "error").mockImplementation(() => {
            throw new Error("synthetic broken log sink");
          })
        : undefined;
      const response = await handler(
        request("/api/board", "GET", undefined, { cookie: user.cookie }),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "storage_unavailable" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("set-cookie")).toBeNull();
      if (sink)
        expect(sink).toHaveBeenCalledExactlyOnceWith(
          '{"event":"account_request_failed"}',
        );
      const retried = await handler(
        request("/api/board", "GET", undefined, { cookie: user.cookie }),
      );
      expect(retried.status).toBe(200);
      expect(await retried.json()).toEqual({ board: null, revision: 0 });
      expect(stderr).toBe(
        sinkThrows ? "" : '{"event":"account_request_failed"}\n',
      );
    },
  );
  it.each([false, true])(
    "shares initialization, retries failures, sanitizes errors and stops on configuration changes when the log sink throws: %s",
    async (sinkThrows) => {
      let attempt = 0;
      const getStore = vi.fn(() => {
        if (++attempt === 1) throw new Error("secret connection string");
        return Promise.resolve(store);
      });
      const mutable = env();
      const api = createHostedHandler(mutable, getStore);
      const sink = sinkThrows
        ? vi.spyOn(console, "error").mockImplementation(() => {
            throw new Error("synthetic broken log sink");
          })
        : undefined;
      const first = await api(request());
      expect(first.status).toBe(503);
      expect(await first.json()).toEqual({ error: "storage_unavailable" });
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(first.headers.get("x-content-type-options")).toBe("nosniff");
      expect(first.headers.get("set-cookie")).toBeNull();
      const responses = await Promise.all([api(request()), api(request())]);
      expect(responses.map((r) => r.status)).toEqual([401, 401]);
      expect(getStore).toHaveBeenCalledTimes(2);
      mutable.SAYBOARD_ORIGIN = "https://other.example.test";
      expect(
        (
          await api(
            new Request(mutable.SAYBOARD_ORIGIN + "/api/auth/session", {
              headers: { "x-forwarded-for": "203.0.113.10" },
            }),
          )
        ).status,
      ).toBe(503);
      if (sink)
        expect(sink).toHaveBeenCalledExactlyOnceWith(
          '{"event":"hosted_handler_failed"}',
        );
      expect(stderr).toBe(
        sinkThrows ? "" : '{"event":"hosted_handler_failed"}\n',
      );
    },
  );
});
