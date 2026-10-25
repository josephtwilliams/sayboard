import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { connect } from "node:net";
import { SqliteStore } from "../store.ts";
import { createApi, SESSION_SECONDS } from "../api.ts";
import { localConfig } from "../config.ts";
import { hashPassword, verifyPassword, tokenHash } from "../password.ts";
import { localServer } from "../http.ts";
import { starterBoard } from "../../src/board.ts";
import { spawnSync } from "node:child_process";

const config = localConfig({
  NODE_ENV: "development",
  SAYBOARD_LOCAL_DEV: "1",
});
const peer = "127.0.0.1";
const handles: SqliteStore[] = [];
const folders: string[] = [];
const store = (path = ":memory:") => {
  const db = new SqliteStore(path);
  handles.push(db);
  return db;
};
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "sayboard-test-"));
  folders.push(dir);
  return dir;
};
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  for (const dir of folders.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
let passwordHash: string;
beforeAll(async () => {
  passwordHash = await hashPassword("admin");
});
function request(
  path: string,
  method = "GET",
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`${config.apiOrigin}${path}`, {
    method,
    headers: {
      ...(method === "GET"
        ? {}
        : { origin: config.origin, "content-type": "application/json" }),
      ...headers,
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}
async function setup(db = store()) {
  await db.seedLocalAdmin();
  let time = 1_000_000;
  const api = await createApi(db, config, () => time);
  const login = await api(
    request("/api/auth/login", "POST", {
      username: "admin",
      password: "admin",
    }),
    peer,
  );
  const data: unknown = await login.json();
  if (
    !data ||
    typeof data !== "object" ||
    !("csrfToken" in data) ||
    typeof data.csrfToken !== "string"
  )
    throw new Error("Login failed");
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  return {
    db,
    api,
    login,
    headers: { cookie, "x-csrf-token": data.csrfToken },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("local-only configuration", () => {
  it("discovers local account configuration without a session and keeps the local boundary", async () => {
    const api = await createApi(store(), config);
    const response = await api(request("/api/auth/capabilities"), peer);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "enabled" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(
      (await api(request("/api/auth/capabilities"), "203.0.113.10")).status,
    ).toBe(403);
    expect(
      (await api(request("/api/auth/capabilities", "POST"), peer)).status,
    ).toBe(405);
  });
  it("requires explicit development opt-in", () => {
    for (const env of [
      {},
      { NODE_ENV: "development" },
      { SAYBOARD_LOCAL_DEV: "1" },
      { SAYBOARD_LOCAL_DEV: "1", NODE_ENV: "production" },
    ])
      expect(() => localConfig(env)).toThrow();
  });
  it("rejects CI development seeding", () => {
    expect(() =>
      localConfig({
        NODE_ENV: "development",
        SAYBOARD_LOCAL_DEV: "1",
        CI: "1",
      }),
    ).toThrow();
  });

  it("rejects public origins and binds only IPv4 loopback", () => {
    for (const origin of [
      "https://example.com",
      "http://127.0.0.1.example.com",
      "http://127.0.0.1/path",
      "http://admin:admin@localhost",
    ])
      expect(() =>
        localConfig({
          NODE_ENV: "development",
          SAYBOARD_LOCAL_DEV: "1",
          SAYBOARD_ORIGIN: origin,
        }),
      ).toThrow();
    expect(() =>
      localConfig({
        NODE_ENV: "development",
        SAYBOARD_LOCAL_DEV: "1",
        SAYBOARD_API_ORIGIN: "http://localhost:5190",
      }),
    ).toThrow();
  });
  it("production startup fails before creating a database", () => {
    const path = join(folder(), "should-not-exist.sqlite");
    const result = spawnSync(process.execPath, ["--import", "tsx", "dev.ts"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        SAYBOARD_LOCAL_DEV: "1",
        SAYBOARD_DATABASE_PATH: path,
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Local authentication is disabled");
    expect(existsSync(path)).toBe(false);
  });
});

describe("passwords and authentication", () => {
  it("salts passwords, verifies them, and rejects malformed hashes", async () => {
    expect(await hashPassword("admin")).not.toBe(passwordHash);
    expect(passwordHash).not.toContain("admin");
    expect(await verifyPassword("admin", passwordHash)).toBe(true);
    expect(await verifyPassword("wrong", passwordHash)).toBe(false);
    expect(await verifyPassword("admin", "scrypt$131072$8$1$bad$bad")).toBe(
      false,
    );
  });
  it("returns a HttpOnly Strict cookie, safe session info, and no-store responses", async () => {
    const { api, login, headers } = await setup();
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toMatch(
      /HttpOnly; SameSite=Strict; Max-Age=28800/,
    );
    expect(login.headers.get("cache-control")).toBe("no-store");
    const response = await api(
      request("/api/auth/session", "GET", undefined, headers),
      peer,
    );
    expect(await response.json()).toEqual({
      account: { username: "admin" },
      csrfToken: headers["x-csrf-token"],
      expiresAt: 1_000_000 + SESSION_SECONDS * 1000,
    });
  });
  it("returns the same error for unknown accounts and wrong passwords", async () => {
    const { api } = await setup();
    for (const username of ["admin", "missing"]) {
      const response = await api(
        request("/api/auth/login", "POST", { username, password: "wrong" }),
        peer,
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "login_failed" });
    }
  });
  it("rotates sessions at login, revokes on logout, and expires them", async () => {
    const { api, headers, advance } = await setup();
    const relogin = await api(
      request(
        "/api/auth/login",
        "POST",
        { username: "admin", password: "admin" },
        headers,
      ),
      peer,
    );
    expect(relogin.headers.get("set-cookie")?.split(";")[0]).not.toBe(
      headers.cookie,
    );
    expect(
      (await api(request("/api/auth/session", "GET", undefined, headers), peer))
        .status,
    ).toBe(401);
    const data = await relogin.json();
    const newer = {
      cookie: relogin.headers.get("set-cookie")?.split(";")[0] ?? "",
      "x-csrf-token": data.csrfToken,
    };
    expect(
      (await api(request("/api/auth/logout", "POST", undefined, newer), peer))
        .status,
    ).toBe(200);
    expect(
      (await api(request("/api/auth/session", "GET", undefined, newer), peer))
        .status,
    ).toBe(401);
    const login = await api(
      request("/api/auth/login", "POST", {
        username: "admin",
        password: "admin",
      }),
      peer,
    );
    advance(SESSION_SECONDS * 1000);
    expect(
      (
        await api(
          request("/api/auth/session", "GET", undefined, {
            cookie: login.headers.get("set-cookie")?.split(";")[0] ?? "",
          }),
          peer,
        )
      ).status,
    ).toBe(401);
  });
  it("caps concurrent password checks before async account lookup", async () => {
    const db = store();
    await db.seedLocalAdmin();
    const originalAccount = db.account.bind(db);
    db.account = async (username) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return originalAccount(username);
    };
    const api = await createApi(db, config);
    const replies = await Promise.all(
      Array.from({ length: 4 }, () =>
        api(
          request("/api/auth/login", "POST", {
            username: "admin",
            password: "admin",
          }),
          peer,
        ),
      ),
    );
    expect(replies.map((reply) => reply.status).sort()).toEqual([
      200, 200, 429, 429,
    ]);
  });
  it("allows only one password calculation on a small hosted server", async () => {
    const db = store();
    const hostedOrigin = "https://pilot.example.test";
    const api = await createApi(db, {
      kind: "hosted",
      origin: hostedOrigin,
      passwordConcurrency: 1,
    });
    const replies = await Promise.all(
      Array.from({ length: 3 }, () =>
        api(
          new Request(`${hostedOrigin}/api/auth/login`, {
            method: "POST",
            headers: {
              origin: hostedOrigin,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              username: "missing",
              password: "synthetic-password-only",
            }),
          }),
          peer,
        ),
      ),
    );
    expect(replies.map((reply) => reply.status).sort()).toEqual([
      401, 429, 429,
    ]);
  });
  it("does not spend the peer budget on logins turned away for concurrency", async () => {
    const db = store();
    const hostedOrigin = "https://pilot.example.test";
    const api = await createApi(
      db,
      { kind: "hosted", origin: hostedOrigin, passwordConcurrency: 1 },
      () => 1_000_000,
    );
    const login = () =>
      api(
        new Request(`${hostedOrigin}/api/auth/login`, {
          method: "POST",
          headers: {
            origin: hostedOrigin,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            username: "missing",
            password: "synthetic-password-only",
          }),
        }),
        peer,
      );
    const first = login();
    // The first request is now hashing; later ones arrive while it runs.
    await new Promise((resolve) => setImmediate(resolve));
    const replies = await Promise.all([first, login(), login()]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([
      401, 429, 429,
    ]);
    // Only the one request that ran scrypt used an attempt.
    for (let i = 0; i < 9; i++)
      expect(await db.allowLogin(peer, 1_000_000)).toBe(true);
    expect(await db.allowLogin(peer, 1_000_000)).toBe(false);
  });
  it("preflights the SQLite budget without charging and respects expiry", async () => {
    const db = store();
    for (let i = 0; i < 20; i++)
      expect(await db.loginAvailable(peer, 1000)).toBe(true);
    for (let i = 0; i < 10; i++)
      expect(await db.allowLogin(peer, 1000)).toBe(true);
    expect(await db.loginAvailable(peer, 300_999)).toBe(false);
    expect(await db.loginAvailable(peer, 301_000)).toBe(true);
    expect(await db.allowLogin(peer, 301_000)).toBe(true);
  });
  it("does not charge capacity-rejected requests in a concurrent cold burst", async () => {
    const db = store();
    const hostedOrigin = "https://pilot.example.test";
    const api = await createApi(
      db,
      { kind: "hosted", origin: hostedOrigin, passwordConcurrency: 1 },
      () => 1_000_000,
    );
    const requests = Array.from({ length: 5 }, () =>
      api(
        new Request(`${hostedOrigin}/api/auth/login`, {
          method: "POST",
          headers: { origin: hostedOrigin, "content-type": "application/json" },
          body: JSON.stringify({
            username: "missing",
            password: "synthetic-password-only",
          }),
        }),
        peer,
      ),
    );
    const replies = await Promise.all(requests);
    expect(replies.map((reply) => reply.status).sort()).toEqual([
      401, 429, 429, 429, 429,
    ]);
    for (let i = 0; i < 9; i++)
      expect(await db.allowLogin(peer, 1_000_000)).toBe(true);
    expect(await db.allowLogin(peer, 1_000_000)).toBe(false);
  });
  it("rechecks the atomic budget and releases the slot after a stale preflight", async () => {
    const db = store();
    const hostedOrigin = "https://pilot.example.test";
    const api = await createApi(
      db,
      { kind: "hosted", origin: hostedOrigin, passwordConcurrency: 1 },
      () => 1_000_000,
    );
    const originalAvailable = db.loginAvailable.bind(db);
    let raced = false;
    db.loginAvailable = async (key, time) => {
      const available = await originalAvailable(key, time);
      if (!raced) {
        raced = true;
        for (let i = 0; i < 10; i++) await db.allowLogin(key, time);
      }
      return available;
    };
    const login = (from: string) =>
      api(
        new Request(`${hostedOrigin}/api/auth/login`, {
          method: "POST",
          headers: { origin: hostedOrigin, "content-type": "application/json" },
          body: JSON.stringify({
            username: "missing",
            password: "synthetic-password-only",
          }),
        }),
        from,
      );
    expect((await login(peer)).status).toBe(429);
    expect((await login("127.0.0.2")).status).toBe(401);
  });
  it("keeps a rate-limited peer from holding the password slot", async () => {
    let arrived = () => {};
    const waiting = new Promise<void>((resolve) => (arrived = resolve));
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const attacker = "192.0.2.10";
    // A database store answers the budget check after a round trip.
    class RemoteStore extends SqliteStore {
      override async loginAvailable(key: string, time: number) {
        if (key === attacker) {
          arrived();
          await gate;
        }
        return super.loginAvailable(key, time);
      }
    }
    const db = new RemoteStore(":memory:");
    handles.push(db);
    for (let i = 0; i < 10; i++)
      await SqliteStore.prototype.allowLogin.call(db, attacker, 1_000_000);
    const hostedOrigin = "https://pilot.example.test";
    const api = await createApi(
      db,
      { kind: "hosted", origin: hostedOrigin, passwordConcurrency: 1 },
      () => 1_000_000,
    );
    const login = (from: string) =>
      api(
        new Request(`${hostedOrigin}/api/auth/login`, {
          method: "POST",
          headers: {
            origin: hostedOrigin,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            username: "missing",
            password: "synthetic-password-only",
          }),
        }),
        from,
      );
    const flood = Array.from({ length: 5 }, () => login(attacker));
    await waiting;
    expect((await login(peer)).status).toBe(401);
    release();
    expect((await Promise.all(flood)).map((reply) => reply.status)).toEqual([
      429, 429, 429, 429, 429,
    ]);
  });
  it("rate limits password work with a persisted budget", async () => {
    const { db, api, advance } = await setup();
    for (let i = 0; i < 9; i++)
      expect(await db.allowLogin(peer, 1_000_000)).toBe(true);
    expect(
      (
        await api(
          request("/api/auth/login", "POST", {
            username: "admin",
            password: "admin",
          }),
          peer,
        )
      ).status,
    ).toBe(429);
    advance(300_001);
    expect(
      (
        await api(
          request("/api/auth/login", "POST", {
            username: "admin",
            password: "admin",
          }),
          peer,
        )
      ).status,
    ).toBe(200);
  });
});

describe("authorization and input boundaries", () => {
  it("requires a session for board reads and writes", async () => {
    const { api } = await setup();
    for (const method of ["GET", "PUT"])
      expect(
        (
          await api(
            request("/api/board", method, method === "PUT" ? {} : undefined),
            peer,
          )
        ).status,
      ).toBe(401);
  });
  it("rejects foreign origins, missing origins, public peers, rebinding hosts and proxy headers", async () => {
    const { api, headers } = await setup();
    expect(
      (
        await api(
          request("/api/auth/session", "GET", undefined, {
            ...headers,
            origin: "https://evil.example",
          }),
          peer,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await api(
          new Request(`${config.apiOrigin}/api/auth/login`, { method: "POST" }),
          peer,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await api(
          request("/api/auth/session", "GET", undefined, headers),
          "192.0.2.1",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await api(
          new Request("http://evil.example/api/auth/session", { headers }),
          peer,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await api(
          request("/api/auth/session", "GET", undefined, {
            ...headers,
            "x-forwarded-host": "localhost",
          }),
          peer,
        )
      ).status,
    ).toBe(403);
  });
  it("requires session-bound CSRF for save and logout", async () => {
    const { api, headers } = await setup();
    for (const path of ["/api/board", "/api/auth/logout"])
      expect(
        (
          await api(
            request(
              path,
              path.endsWith("board") ? "PUT" : "POST",
              {},
              { cookie: headers.cookie },
            ),
            peer,
          )
        ).status,
      ).toBe(403);
    expect(
      (
        await api(
          request(
            "/api/board",
            "PUT",
            {},
            { ...headers, "x-csrf-token": "0".repeat(64) },
          ),
          peer,
        )
      ).status,
    ).toBe(403);
  });
  it("validates JSON, size, board shape and revisions", async () => {
    const { api, headers } = await setup();
    expect(
      (
        await api(
          request("/api/board", "PUT", { board: {}, revision: 0 }, headers),
          peer,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await api(
          request(
            "/api/board",
            "PUT",
            { board: starterBoard(), revision: -1 },
            headers,
          ),
          peer,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await api(
          request(
            "/api/board",
            "PUT",
            {
              board: { ...starterBoard(), voice: "x".repeat(100_000) },
              revision: 0,
            },
            headers,
          ),
          peer,
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await api(
          new Request(`${config.apiOrigin}/api/board`, {
            method: "PUT",
            headers: {
              ...headers,
              origin: config.origin,
              "content-type": "application/json",
            },
            body: "{",
          }),
          peer,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await api(
          request(
            "/api/board",
            "PUT",
            {},
            { ...headers, "content-type": "text/plain" },
          ),
          peer,
        )
      ).status,
    ).toBe(415);
  });
  it("handles unknown routes, methods and cookie ambiguity", async () => {
    const { api, headers } = await setup();
    expect((await api(request("/api/missing"), peer)).status).toBe(404);
    expect(
      (await api(request("/api/board", "POST", {}, headers), peer)).status,
    ).toBe(405);
    expect(
      (await api(request("/api/board?account=someone"), peer)).status,
    ).toBe(400);
    expect(
      (
        await api(
          request("/api/board", "GET", undefined, {
            cookie: `${headers.cookie}; ${headers.cookie}`,
          }),
          peer,
        )
      ).status,
    ).toBe(401);
  });
});

describe("account boards and real persistence", () => {
  it("isolates accounts, ignores supplied owner IDs, and rejects stale writes", async () => {
    const { db, api, headers } = await setup();
    await db.addAccount("second", "a-long-test-password");
    const second = await api(
      request("/api/auth/login", "POST", {
        username: "second",
        password: "a-long-test-password",
      }),
      peer,
    );
    const secondHeaders = {
      cookie: second.headers.get("set-cookie")?.split(";")[0] ?? "",
    };
    const empty = await api(
      request("/api/board", "GET", undefined, headers),
      peer,
    );
    expect(await empty.json()).toEqual({ board: null, revision: 0 });
    const board = starterBoard();
    const response = await api(
      request(
        "/api/board",
        "PUT",
        { board, revision: 0, accountId: "second" },
        headers,
      ),
      peer,
    );
    expect(await response.json()).toEqual({ board, revision: 1 });
    expect(
      await (
        await api(request("/api/board", "GET", undefined, secondHeaders), peer)
      ).json(),
    ).toEqual({ board: null, revision: 0 });
    expect(
      (
        await api(
          request("/api/board", "PUT", { board, revision: 0 }, headers),
          peer,
        )
      ).status,
    ).toBe(409);
    expect(
      await (
        await api(
          request("/api/board", "PUT", { board, revision: 1 }, headers),
          peer,
        )
      ).json(),
    ).toEqual({ board, revision: 2 });
  });
  it("persists accounts, boards, sessions and rate budget after reopening, with no raw secrets", async () => {
    const path = join(folder(), "test.sqlite");
    let db = store(path);
    await db.seedLocalAdmin();
    const account = await db.account("admin");
    if (!account) throw new Error("Missing seeded account");
    const token = "a".repeat(64);
    await db.createSession(tokenHash(token), account.id, 9999);
    await db.saveBoard(account.id, starterBoard(), 0);
    for (let i = 0; i < 10; i++) await db.allowLogin(peer, 1);
    db.close();
    handles.splice(handles.indexOf(db), 1);
    db = store(path);
    await db.seedLocalAdmin();
    expect((await db.account("admin"))?.id).toBe(account.id);
    expect((await db.board(account.id))?.board).toEqual(starterBoard());
    expect((await db.session(tokenHash(token), 2))?.account.id).toBe(
      account.id,
    );
    expect(await db.allowLogin(peer, 2)).toBe(false);
    expect(readFileSync(path).includes(Buffer.from(token))).toBe(false);
    expect(readFileSync(path).includes(Buffer.from('"password":"admin"'))).toBe(
      false,
    );
  });
  it("executes the actual HTTP adapter over loopback", async () => {
    const db = store();
    await db.seedLocalAdmin();
    const server = localServer((request, peer) => api(request, peer));
    server.listen(0, peer);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server address");
    const api = await createApi(db, {
      ...config,
      apiOrigin: `http://${peer}:${address.port}`,
    });
    try {
      const response = await fetch(
        `http://${peer}:${address.port}/api/auth/login`,
        {
          method: "POST",
          headers: {
            origin: config.origin,
            "content-type": "application/json",
          },
          body: JSON.stringify({ username: "admin", password: "admin" }),
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      // Longer than Caddy's 2-minute idle upstream keep-alive.
      expect(response.headers.get("keep-alive")).toBe("timeout=130");
      const session = await response.json();
      const headers = {
        origin: config.origin,
        "content-type": "application/json",
        cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
        "x-csrf-token": session.csrfToken,
      };
      const url = `http://${peer}:${address.port}/api/board`;
      const board = starterBoard();
      const saved = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify({ board, revision: 0 }),
      });
      expect(await saved.json()).toEqual({ board, revision: 1 });
      expect(await (await fetch(url, { headers })).json()).toEqual({
        board,
        revision: 1,
      });
      const oversized = await fetch(url, {
        method: "PUT",
        headers,
        body: "x".repeat(100_001),
      });
      expect(oversized.status).toBe(413);
      const logout = await fetch(
        `http://${peer}:${address.port}/api/auth/logout`,
        { method: "POST", headers },
      );
      expect(logout.status).toBe(200);
      expect((await fetch(url, { headers })).status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  });
  it("closes kept-alive connections after in-flight responses at shutdown", async () => {
    const pending: ((response: Response) => void)[] = [];
    const server = localServer(
      () => new Promise<Response>((resolve) => pending.push(resolve)),
    );
    server.listen(0, peer);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server address");
    const socket = connect(address.port, peer);
    let received = "";
    socket.setEncoding("utf8").on("data", (chunk) => (received += chunk));
    socket.write(`GET / HTTP/1.1\r\nHost: ${peer}\r\n\r\n`);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const closed = Promise.all([once(socket, "close"), once(server, "close")]);
    // Same sequence as the production server's SIGTERM handler.
    server.close();
    server.closeIdleConnections();
    const responded = Date.now();
    pending[0](new Response("ok"));
    await closed;
    expect(Date.now() - responded).toBeLessThan(2_000);
    // The complete chunked response arrives before the connection closes.
    expect(received).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(received).toMatch(/\r\n\r\n2\r\nok\r\n0\r\n\r\n$/);
  });
});
