import { beforeEach, afterEach, it, expect } from "vitest";
import { SqliteStore } from "../store.ts";
import { createApi } from "../api.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenHash } from "../password.ts";
import { INVITE_MS, RESET_MS } from "../onboarding.ts";
import type { InvitationMail } from "../mail.ts";
import { record, text } from "../../src/classroom-contract.ts";

const origin = "https://classroom.example.test";
const password = "Synthetic original account password";
const replacement = "Synthetic replacement teacher password";
let store: SqliteStore;
let api: Awaited<ReturnType<typeof createApi>>;
let directory: string;
let now: number;
type Actor = { cookie: string; csrf: string };
let owner: Actor;
let teacher: Actor;
function request(
  path: string,
  method = "GET",
  payload?: unknown,
  actor?: Actor,
  headers: Record<string, string> = {},
) {
  return api(
    new Request(origin + path, {
      method,
      headers: {
        ...(method === "GET"
          ? {}
          : { Origin: origin, "Content-Type": "application/json" }),
        ...(actor ? { Cookie: actor.cookie, "X-CSRF-Token": actor.csrf } : {}),
        ...headers,
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }),
    "synthetic-peer",
  );
}
async function login(username: string, secret = password): Promise<Actor> {
  const response = await request("/api/auth/login", "POST", {
    username,
    password: secret,
  });
  expect(response.status).toBe(200);
  return {
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    csrf: text(record(await response.json()).csrfToken),
  };
}
async function issue(username = "new_teacher", kind = "invite") {
  const response = await request(
    "/api/invitations",
    "POST",
    { username, kind },
    owner,
  );
  expect(response.status).toBe(201);
  const value = record(await response.json());
  const url = new URL(text(value.url, 400));
  expect(url.origin).toBe(origin);
  expect(url.search).toBe("");
  return new URLSearchParams(url.hash.slice(1)).get("activate") ?? "";
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sayboard-onboarding-"));
  store = new SqliteStore(join(directory, "db.sqlite"));
  await store.addAccount("organiser", password, false);
  await store.addAccount("teacher", password, false);
  store.onboarding.enableOperator("organiser");
  now = Date.now();
  api = await createApi(
    store,
    { kind: "hosted", origin, passwordConcurrency: 2 },
    () => now,
  );
  owner = await login("organiser");
  teacher = await login("teacher");
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
it("restricts invitations to an explicitly provisioned organiser", async () => {
  expect(
    await (await request("/api/invitations", "GET", undefined, teacher)).json(),
  ).toMatchObject({ operator: false });
  expect(
    (
      await request(
        "/api/invitations",
        "POST",
        { username: "intruder", kind: "invite", operator: true },
        teacher,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/api/invitations", "POST", {
        username: "intruder",
        kind: "invite",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request("/api/auth/signup", "POST", {
        username: "intruder",
        password,
      })
    ).status,
  ).toBe(404);
});
it("stores only a token hash, activates once and never grants organiser privileges", async () => {
  const token = await issue();
  const db = new DatabaseSync(join(directory, "db.sqlite"));
  const stored = db.prepare("SELECT token_hash FROM account_invitations").get();
  expect(stored?.token_hash).toBe(tokenHash(token));
  expect(stored?.token_hash).not.toBe(token);
  db.close();
  expect(
    await (
      await request("/api/auth/activation/inspect", "POST", { token })
    ).json(),
  ).toEqual({
    username: "new_teacher",
    kind: "invite",
    expiresAt: now + INVITE_MS,
  });
  expect(
    (
      await request("/api/auth/activation", "POST", {
        token,
        password: replacement,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await request("/api/auth/activation", "POST", {
        token,
        password: replacement,
      })
    ).status,
  ).toBe(410);
  const user = await login("new_teacher", replacement);
  expect(
    await (await request("/api/invitations", "GET", undefined, user)).json(),
  ).toMatchObject({ operator: false });
});
it("handles concurrent acceptance atomically", async () => {
  const token = await issue();
  const results = await Promise.all([
    request("/api/auth/activation", "POST", { token, password: replacement }),
    request("/api/auth/activation", "POST", { token, password: replacement }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
});
it("reports a username taken by an operator-created account after the invitation", async () => {
  const token = await issue();
  await store.addAccount("new_teacher", password, false);
  const response = await request("/api/auth/activation", "POST", {
    token,
    password: replacement,
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "username_taken" });
  await login("new_teacher");
});
it("lets only the issuing organiser cancel a pending link", async () => {
  const token = await issue();
  expect(
    (
      await request(
        "/api/invitations",
        "DELETE",
        { username: "new_teacher" },
        teacher,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        "/api/invitations",
        "DELETE",
        { username: "new_teacher" },
        owner,
      )
    ).status,
  ).toBe(200);
  expect(
    (await request("/api/auth/activation/inspect", "POST", { token })).status,
  ).toBe(410);
});
it("sends only the requested transactional invitation and retains a valid fallback on delivery failure", async () => {
  const sent: InvitationMail[] = [];
  api = await createApi(store, { kind: "hosted", origin }, () => now, {
    send: async (message) => {
      if (message.kind !== "email") sent.push(message);
    },
    verify: async () => {},
  });
  const response = await request(
    "/api/invitations",
    "POST",
    {
      username: "email_teacher",
      kind: "invite",
      delivery: "email",
      email: "demo@example.test",
    },
    owner,
  );
  expect(response.status).toBe(201);
  const invitation = record(await response.json());
  expect(invitation.emailStatus).toBe("accepted");
  expect(sent).toEqual([
    {
      username: "email_teacher",
      kind: "invite",
      expiresAt: now + INVITE_MS,
      to: "demo@example.test",
      url: invitation.url,
    },
  ]);
  api = await createApi(store, { kind: "hosted", origin }, () => now, {
    send: async () => {
      throw new Error("synthetic transport failure with private details");
    },
    verify: async () => {},
  });
  const failed = await request(
    "/api/invitations",
    "POST",
    {
      username: "retry_teacher",
      kind: "invite",
      delivery: "email",
      email: "demo@example.test",
    },
    owner,
  );
  const fallback = record(await failed.json());
  expect(fallback.emailStatus).toBe("failed");
  expect(JSON.stringify(fallback)).not.toContain("private details");
  const token = new URLSearchParams(
    new URL(text(fallback.url, 400)).hash.slice(1),
  ).get("activate");
  expect(
    (await request("/api/auth/activation/inspect", "POST", { token })).status,
  ).toBe(200);
});
it("rejects unconfigured mail and malformed recipient headers without issuing an invitation", async () => {
  expect(
    (
      await request(
        "/api/invitations",
        "POST",
        {
          username: "not_created",
          kind: "invite",
          delivery: "email",
          email: "demo@example.test",
        },
        owner,
      )
    ).status,
  ).toBe(503);
  expect(await store.account("not_created")).toBeNull();
  api = await createApi(store, { kind: "hosted", origin }, () => now, {
    send: async () => {
      throw new Error("must not send");
    },
    verify: async () => {},
  });
  expect(
    (
      await request(
        "/api/invitations",
        "POST",
        {
          username: "not_created",
          kind: "invite",
          delivery: "email",
          email: "demo@example.test\r\nBcc: stranger@example.test",
        },
        owner,
      )
    ).status,
  ).toBe(400);
});
it("expires and rotates unused links, and rejects short passwords without consuming them", async () => {
  const old = await issue();
  const token = await issue();
  expect(
    (await request("/api/auth/activation/inspect", "POST", { token: old }))
      .status,
  ).toBe(410);
  expect(
    (
      await request("/api/auth/activation", "POST", {
        token,
        password: "short",
      })
    ).status,
  ).toBe(400);
  expect(
    (await request("/api/auth/activation/inspect", "POST", { token })).status,
  ).toBe(200);
  now += INVITE_MS;
  expect(
    (
      await request("/api/auth/activation", "POST", {
        token,
        password: replacement,
      })
    ).status,
  ).toBe(410);
});
it("resets an existing password and revokes its sessions", async () => {
  const token = await issue("teacher", "reset");
  expect(
    record(
      await (
        await request("/api/auth/activation/inspect", "POST", { token })
      ).json(),
    ).expiresAt,
  ).toBe(now + RESET_MS);
  expect(
    (
      await request("/api/auth/activation", "POST", {
        token,
        password: replacement,
      })
    ).status,
  ).toBe(200);
  expect(
    (await request("/api/auth/session", "GET", undefined, teacher)).status,
  ).toBe(401);
  expect(
    (
      await request("/api/auth/login", "POST", {
        username: "teacher",
        password,
      })
    ).status,
  ).toBe(401);
  await login("teacher", replacement);
});
it("rejects mismatched account states, foreign origins and missing CSRF", async () => {
  expect(
    (
      await request(
        "/api/invitations",
        "POST",
        { username: "teacher", kind: "invite" },
        owner,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        "/api/invitations",
        "POST",
        { username: "missing", kind: "reset" },
        owner,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await request(
        "/api/invitations",
        "POST",
        { username: "someone", kind: "invite" },
        owner,
        { "X-CSRF-Token": "" },
      )
    ).status,
  ).toBe(403);
  const token = await issue();
  expect(
    (
      await request(
        "/api/auth/activation",
        "POST",
        { token, password: replacement },
        undefined,
        { Origin: "https://foreign.test" },
      )
    ).status,
  ).toBe(403);
});
it("caps password creation at the small-VPS limit and bounds token guessing", async () => {
  api = await createApi(
    store,
    { kind: "hosted", origin, passwordConcurrency: 1 },
    () => now,
  );
  const a = await issue("teacher_a");
  const b = await issue("teacher_b");
  const results = await Promise.all([
    request("/api/auth/activation", "POST", {
      token: a,
      password: replacement,
    }),
    request("/api/auth/activation", "POST", {
      token: b,
      password: replacement,
    }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 429]);
  now += 300_001;
  for (let i = 0; i < 10; i++)
    expect(
      (
        await request("/api/auth/activation/inspect", "POST", {
          token: "0".repeat(64),
        })
      ).status,
    ).toBe(410);
  expect(
    (await request("/api/auth/activation/inspect", "POST", { token: b }))
      .status,
  ).toBe(429);
});
it("keeps invitation state through snapshot recovery and deletes issued links with an account", async () => {
  const token = await issue();
  const path = join(directory, "snapshot.sqlite");
  await store.backup(path);
  const restored = new SqliteStore(path);
  expect(restored.onboarding.inspect(tokenHash(token), now).username).toBe(
    "new_teacher",
  );
  restored.close();
  store.deleteAccount("organiser");
  expect(() => store.onboarding.inspect(tokenHash(token), now)).toThrow();
});
