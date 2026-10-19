import { describe, expect, it } from "vitest";
import { AccountError, createAccountClient } from "../src/account";
import { starterBoard, type Board } from "../src/board";

const sessionResponse = {
  account: { username: "caregiver-test" },
  csrfToken: "csrf-test-only",
  expiresAt: 2_000_000_000,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fixture(...responses: (Response | Promise<Response>)[]) {
  const calls: { path: RequestInfo | URL; options: RequestInit | undefined }[] =
    [];
  const fetcher: typeof fetch = async (path, options) => {
    calls.push({ path, options });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected additional request");
    return response;
  };
  return { client: createAccountClient(fetcher), calls };
}

function deferredResponse() {
  let resolveResponse = (_response: Response): void => {
    void _response;
    throw new Error("Deferred response has not been initialized");
  };
  const promise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  return {
    promise,
    resolve: (response: Response) => resolveResponse(response),
  };
}

function customBoard(): Board {
  const board = starterBoard();
  board.size = "extra-large";
  board.tiles[1] = null;
  board.tiles[7] = {
    kind: "word",
    id: "status",
    label: "Apple",
    phrase: "Please give me an apple.",
    icon: "emoji:1f34e",
    tone: "peach",
  };
  while (board.tiles.length < 60) board.tiles.push(null);
  return board;
}

describe("same-origin account client contract", () => {
  it("remembers deliberate disablement and blocks all account operations without requests", async () => {
    const { client, calls } = fixture(json({ state: "disabled" }));
    expect(client.currentAvailability()).toBeNull();
    await expect(client.checkAvailability()).resolves.toEqual({
      state: "disabled",
    });
    await expect(client.checkAvailability()).resolves.toEqual({
      state: "disabled",
    });
    for (const run of [
      () => client.restoreSession(),
      () => client.login("synthetic", "synthetic-password"),
      () => client.loadBoard(),
      () => client.saveBoard(customBoard(), 0),
      () => client.logout(),
    ])
      await expect(run()).rejects.toMatchObject({ status: 503 });
    expect(client.currentSession()).toBeNull();
    expect(calls).toEqual([
      {
        path: "/api/auth/capabilities",
        options: { cache: "no-store", credentials: "same-origin" },
      },
    ]);
  });

  it("coalesces concurrent capability discovery and permits an explicit recheck after enablement", async () => {
    const pending = deferredResponse();
    const { client, calls } = fixture(
      pending.promise,
      json({ state: "enabled" }),
      json(sessionResponse),
    );
    const checks = [client.checkAvailability(), client.checkAvailability()];
    expect(calls).toHaveLength(1);
    pending.resolve(json({ state: "disabled" }));
    expect(await Promise.all(checks)).toEqual([
      { state: "disabled" },
      { state: "disabled" },
    ]);
    await expect(client.checkAvailability({ refresh: true })).resolves.toEqual({
      state: "enabled",
    });
    await expect(client.restoreSession()).resolves.toEqual(sessionResponse);
    expect(calls.map((call) => call.path)).toEqual([
      "/api/auth/capabilities",
      "/api/auth/capabilities",
      "/api/auth/session",
    ]);
  });

  it("clears an existing session when an explicit recheck finds accounts disabled", async () => {
    const { client, calls } = fixture(
      json({ state: "enabled" }),
      json(sessionResponse),
      json({ state: "disabled" }),
    );
    await client.checkAvailability();
    await client.login("synthetic", "synthetic-password");
    await client.checkAvailability({ refresh: true });
    expect(client.currentSession()).toBeNull();
    await expect(client.saveBoard(customBoard(), 0)).rejects.toMatchObject({
      status: 503,
    });
    expect(calls).toHaveLength(3);
  });

  it("keeps configured account outages as failures, without caching them as disabled", async () => {
    const { client, calls } = fixture(
      json({ state: "enabled" }),
      json({ error: "storage_unavailable" }, 503),
      json(sessionResponse),
    );
    await client.checkAvailability();
    await expect(client.restoreSession()).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("unavailable"),
    });
    expect(client.currentAvailability()).toEqual({ state: "enabled" });
    await expect(client.checkAvailability()).resolves.toEqual({
      state: "enabled",
    });
    await expect(client.restoreSession()).resolves.toEqual(sessionResponse);
    expect(calls).toHaveLength(3);
  });

  it.each([503, 500, 404])(
    "does not cache failed capability discovery: %s",
    async (status) => {
      const { client, calls } = fixture(
        json({ error: "auth_unconfigured" }, status),
        json({ state: "enabled" }),
      );
      await expect(client.checkAvailability()).rejects.toMatchObject({
        status,
      });
      expect(client.currentAvailability()).toBeNull();
      await expect(client.checkAvailability()).resolves.toEqual({
        state: "enabled",
      });
      expect(calls).toHaveLength(2);
    },
  );

  it.each([
    null,
    {},
    { state: true },
    { state: "unavailable" },
    { state: ["disabled"] },
  ])(
    "rejects malformed capability discovery without assuming accounts are disabled: %j",
    async (value) => {
      const { client } = fixture(json(value));
      await expect(client.checkAvailability()).rejects.toMatchObject({
        status: 502,
      });
      expect(client.currentAvailability()).toBeNull();
    },
  );

  it("rejects every overlapping operation and permits a retry after completion", async () => {
    const pending = deferredResponse();
    const { client, calls } = fixture(pending.promise, json({ ok: true }));
    const login = client.login("caregiver-test", "test-password");
    const blocked = [
      client.login("other-test-user", "test-password"),
      client.restoreSession(),
      client.logout(),
      client.loadBoard(),
      client.saveBoard(customBoard(), 0),
    ];
    await Promise.all(
      blocked.map((result) =>
        expect(result).rejects.toMatchObject({
          status: 0,
          message: expect.stringContaining("already in progress"),
        }),
      ),
    );
    expect(calls).toHaveLength(1);
    expect(client.currentSession()).toBeNull();
    pending.resolve(json(sessionResponse));
    await expect(login).resolves.toEqual(sessionResponse);
    await expect(client.logout()).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(client.currentSession()).toBeNull();
  });

  it.each([401, 409, 503])(
    "releases the operation lock after a failed request with status %s",
    async (status) => {
      const pending = deferredResponse();
      const { client, calls } = fixture(pending.promise, json(sessionResponse));
      const loading = client.loadBoard();
      const failure = expect(loading).rejects.toMatchObject({ status });
      await expect(client.restoreSession()).rejects.toMatchObject({
        message: expect.stringContaining("already in progress"),
      });
      pending.resolve(json({}, status));
      await failure;
      await expect(client.restoreSession()).resolves.toEqual(sessionResponse);
      expect(calls).toHaveLength(2);
    },
  );

  it("releases the operation lock after validation failure without sending invalid data", async () => {
    const { client, calls } = fixture(
      json(sessionResponse),
      json({ board: null, revision: 0 }),
    );
    await client.login("caregiver-test", "test-password");
    await expect(client.saveBoard(customBoard(), -1)).rejects.toMatchObject({
      status: 400,
    });
    await expect(client.loadBoard()).resolves.toEqual({
      board: null,
      revision: 0,
    });
    expect(calls).toHaveLength(2);
  });

  it("releases the operation lock after parsing a malformed successful response", async () => {
    const { client, calls } = fixture(
      json({ invalid: true }),
      json(sessionResponse),
    );
    await expect(client.restoreSession()).rejects.toMatchObject({
      status: 502,
    });
    await expect(client.restoreSession()).resolves.toEqual(sessionResponse);
    expect(calls).toHaveLength(2);
  });

  it("logs in with exact credentials JSON and does not read or upload a board", async () => {
    const { client, calls } = fixture(json(sessionResponse));
    expect(await client.login("caregiver-test", "test-password")).toEqual(
      sessionResponse,
    );
    expect(client.currentSession()).toEqual(sessionResponse);
    expect(calls).toEqual([
      {
        path: "/api/auth/login",
        options: {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: "caregiver-test",
            password: "test-password",
          }),
        },
      },
    ]);
  });

  it("restores the session with same-origin cookies and no board upload", async () => {
    const { client, calls } = fixture(json(sessionResponse));
    expect(await client.restoreSession()).toEqual(sessionResponse);
    expect(calls).toEqual([
      {
        path: "/api/auth/session",
        options: { credentials: "same-origin" },
      },
    ]);
  });

  it("treats a restore 401 as signed out and makes no fallback request", async () => {
    const { client, calls } = fixture(json(sessionResponse), json({}, 401));
    await client.login("caregiver-test", "test-password");
    expect(await client.restoreSession()).toBeNull();
    expect(client.currentSession()).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("sends logout CSRF and clears memory only after a successful response", async () => {
    const { client, calls } = fixture(
      json(sessionResponse),
      json({ ok: true }),
    );
    await client.login("caregiver-test", "test-password");
    await client.logout();
    expect(client.currentSession()).toBeNull();
    expect(calls[1]).toEqual({
      path: "/api/auth/logout",
      options: {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": "csrf-test-only",
        },
      },
    });
  });

  it("reads the empty account and preserves emoji, sizes, IDs and holes on explicit save", async () => {
    const board = customBoard();
    const original = structuredClone(board);
    const { client, calls } = fixture(
      json(sessionResponse),
      json({ board: null, revision: 0 }),
      json({ board, revision: 1 }),
      json({ board, revision: 1 }),
    );
    await client.login("caregiver-test", "test-password");
    expect(await client.loadBoard()).toEqual({ board: null, revision: 0 });
    expect(await client.saveBoard(board, 0)).toEqual({ board, revision: 1 });
    expect(await client.loadBoard()).toEqual({ board, revision: 1 });
    expect(calls[2]).toEqual({
      path: "/api/board",
      options: {
        method: "PUT",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": "csrf-test-only",
        },
        body: expect.any(String),
      },
    });
    expect(JSON.parse(String(calls[2].options?.body))).toEqual({
      board,
      revision: 0,
    });
    expect(calls[1]).toEqual({
      path: "/api/board",
      options: { credentials: "same-origin" },
    });
    expect(calls[3]).toEqual(calls[1]);
    expect(board).toEqual(original);
  });

  it("surfaces a 409 without silently retrying or changing the local board", async () => {
    const board = customBoard();
    const original = structuredClone(board);
    const { client, calls } = fixture(json(sessionResponse), json({}, 409));
    await client.login("caregiver-test", "test-password");
    await expect(client.saveBoard(board, 7)).rejects.toMatchObject({
      status: 409,
    });
    expect(calls).toHaveLength(2);
    expect(board).toEqual(original);
    expect(client.currentSession()).toEqual(sessionResponse);
  });

  it("clears the session when an account request returns 401", async () => {
    const { client, calls } = fixture(json(sessionResponse), json({}, 401));
    await client.login("caregiver-test", "test-password");
    await expect(client.loadBoard()).rejects.toMatchObject({ status: 401 });
    expect(client.currentSession()).toBeNull();
    await expect(client.saveBoard(customBoard(), 0)).rejects.toMatchObject({
      status: 401,
    });
    expect(calls).toHaveLength(2);
  });

  it("recovers a rotated-cookie stale-CSRF 403 during save without retrying", async () => {
    const board = customBoard();
    const original = structuredClone(board);
    const refreshedSession = {
      ...sessionResponse,
      csrfToken: "rotated-csrf-test-only",
    };
    const { client, calls } = fixture(
      json(sessionResponse),
      json({}, 403),
      json(refreshedSession),
    );
    await client.login("caregiver-test", "test-password");
    await expect(client.saveBoard(board, 7)).rejects.toMatchObject({
      status: 403,
    });
    expect(client.currentSession()).toBeNull();
    expect(calls).toHaveLength(2);
    expect(board).toEqual(original);
    expect(calls[1].options?.headers).toMatchObject({
      "X-CSRF-Token": sessionResponse.csrfToken,
    });
    await expect(client.restoreSession()).resolves.toEqual(refreshedSession);
    expect(client.currentSession()).toEqual(refreshedSession);
    expect(calls.map((call) => call.path)).toEqual([
      "/api/auth/login",
      "/api/board",
      "/api/auth/session",
    ]);
    expect(board).toEqual(original);
  });

  it("refreshes a rotated CSRF token and retries logout once so the server session ends", async () => {
    const refreshedSession = {
      ...sessionResponse,
      csrfToken: "rotated-csrf-test-only",
    };
    const { client, calls } = fixture(
      json(sessionResponse),
      json({ error: "csrf_rejected" }, 403),
      json(refreshedSession),
      json({ ok: true }),
    );
    await client.login("caregiver-test", "test-password");
    await expect(client.logout()).resolves.toBeUndefined();
    expect(client.currentSession()).toBeNull();
    expect(
      calls.map((call) => [
        call.path,
        (call.options?.headers as Record<string, string> | undefined)?.[
          "X-CSRF-Token"
        ],
      ]),
    ).toEqual([
      ["/api/auth/login", undefined],
      ["/api/auth/logout", sessionResponse.csrfToken],
      ["/api/auth/session", undefined],
      ["/api/auth/logout", refreshedSession.csrfToken],
    ]);
  });

  it("reports a logout that still fails and stays signed in", async () => {
    const refreshedSession = {
      ...sessionResponse,
      csrfToken: "rotated-csrf-test-only",
    };
    const { client, calls } = fixture(
      json(sessionResponse),
      json({ error: "csrf_rejected" }, 403),
      json(refreshedSession),
      json({}, 503),
    );
    await client.login("caregiver-test", "test-password");
    await expect(client.logout()).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("Sign out did not finish"),
    });
    expect(client.currentSession()).toEqual(refreshedSession);
    expect(calls).toHaveLength(4);
  });

  it("reports unavailable storage without account fallback or successful sync", async () => {
    const { client, calls } = fixture(json({}, 503));
    await expect(
      client.login("caregiver-test", "test-password"),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining("unavailable"),
    });
    expect(client.currentSession()).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("keeps an existing session when an attempted save or logout returns 503", async () => {
    const { client, calls } = fixture(
      json(sessionResponse),
      json({}, 503),
      json({}, 503),
    );
    await client.login("caregiver-test", "test-password");
    await expect(client.saveBoard(customBoard(), 0)).rejects.toMatchObject({
      status: 503,
    });
    await expect(client.logout()).rejects.toMatchObject({ status: 503 });
    expect(client.currentSession()).toEqual(sessionResponse);
    expect(calls).toHaveLength(3);
  });

  it("surfaces session restore unavailability and does not treat it as a successful sign-in", async () => {
    const { client, calls } = fixture(json({}, 503));
    await expect(client.restoreSession()).rejects.toMatchObject({
      status: 503,
    });
    expect(client.currentSession()).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("rejects a malformed successful save response without retrying the upload", async () => {
    const { client, calls } = fixture(
      json(sessionResponse),
      json({ board: null, revision: "1" }),
    );
    await client.login("caregiver-test", "test-password");
    await expect(client.saveBoard(customBoard(), 0)).rejects.toMatchObject({
      status: 502,
    });
    expect(calls).toHaveLength(2);
  });

  it("clears the old session if another login fails", async () => {
    const { client, calls } = fixture(json(sessionResponse), json({}, 401));
    await client.login("caregiver-test", "test-password");
    await expect(
      client.login("other-test-user", "incorrect-test-password"),
    ).rejects.toMatchObject({ status: 401 });
    expect(client.currentSession()).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it.each([
    null,
    {},
    { username: "caregiver-test", csrfToken: "token" },
    { ...sessionResponse, account: { username: "" } },
    { ...sessionResponse, csrfToken: "" },
    { ...sessionResponse, expiresAt: "tomorrow" },
  ])("rejects malformed session response %j", async (response) => {
    const { client } = fixture(json(response));
    await expect(
      client.login("caregiver-test", "test-password"),
    ).rejects.toMatchObject({ status: 502 });
    expect(client.currentSession()).toBeNull();
  });

  it.each([
    {},
    { board: null, revision: -1 },
    { board: null, revision: 1.5 },
    { board: null, revision: Number.MAX_SAFE_INTEGER + 1 },
    { board: null, revision: "0" },
    { board: { version: 2, tiles: [null] }, revision: 0 },
    { board: { version: 1, tiles: [] }, revision: 0 },
  ])("rejects malformed account board response %j", async (response) => {
    const { client } = fixture(json(response));
    await expect(client.loadBoard()).rejects.toMatchObject({ status: 502 });
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid save revision %s before making a request",
    async (revision) => {
      const { client, calls } = fixture(json(sessionResponse));
      await client.login("caregiver-test", "test-password");
      await expect(
        client.saveBoard(customBoard(), revision),
      ).rejects.toMatchObject({ status: 400 });
      expect(calls).toHaveLength(1);
    },
  );

  it("rejects invalid board data before upload", async () => {
    const { client, calls } = fixture(json(sessionResponse));
    await client.login("caregiver-test", "test-password");
    const board = customBoard();
    board.tiles[0] = {
      ...board.tiles[7],
      kind: "word",
      id: "duplicate",
      label: "",
      phrase: "",
      icon: "heart",
      tone: "mint",
    };
    await expect(client.saveBoard(board, 0)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("preflights oversized legacy migration before transmitting or changing the session", async () => {
    const { client, calls } = fixture(json(sessionResponse));
    await client.login("caregiver-test", "test-password");
    const legacy = {
      version: 1,
      tiles: [
        {
          id: "synthetic",
          label: "Demo",
          phrase: "Demo",
          icon: "heart",
          tone: "mint",
        },
      ],
      voice: "声".repeat(40_000),
      rate: 0.85,
      size: "standard",
    };
    const result: unknown = Reflect.apply(client.saveBoard, client, [
      legacy,
      0,
    ]);
    await expect(result).rejects.toThrow("too large");
    expect(calls).toHaveLength(1);
    expect(client.currentSession()).not.toBeNull();
    expect(legacy.voice).toHaveLength(40_000);
  });

  it("reports malformed JSON and unreachable storage as typed errors", async () => {
    const { client } = fixture(new Response("not json"));
    await expect(client.restoreSession()).rejects.toBeInstanceOf(AccountError);
    await expect(client.restoreSession()).rejects.toMatchObject({ status: 0 });
    expect(client.currentSession()).toBeNull();
  });
});
