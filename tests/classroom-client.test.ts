import { afterEach, describe, expect, it, vi } from "vitest";
import { starterBoard } from "../src/board";

const profileId = "ac860f41-f706-4359-8cb8-2c71d8adb24e";
const profilePath = `/api/profiles/${profileId}`;
const session = {
  account: { username: "teacher-test" },
  csrfToken: "csrf-test-only",
  expiresAt: 2_000_000_000,
};
const rotatedSession = { ...session, csrfToken: "rotated-csrf-test-only" };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function profile(revision: number) {
  return {
    id: profileId,
    label: "Synthetic learner",
    revision,
    publishedVersion: 0,
    board: starterBoard(),
    versions: [],
    devices: [],
  };
}

// The teacher client shares the page-wide account client, so both load with a
// stubbed fetch, then restore the session as the classroom editor does on load.
async function editor(...responses: Response[]) {
  const calls: {
    request: string;
    csrf: string | undefined;
    body: unknown;
  }[] = [];
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    async (path: RequestInfo | URL, options: RequestInit = {}) => {
      const headers = options.headers as Record<string, string> | undefined;
      calls.push({
        request: `${options.method ?? "GET"} ${String(path)}`,
        csrf: headers?.["X-CSRF-Token"],
        body:
          options.body === undefined
            ? undefined
            : JSON.parse(String(options.body)),
      });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected additional request");
      return response;
    },
  );
  const { accountClient } = await import("../src/account");
  const { teacherClient, ClassroomError } =
    await import("../src/classroom-client");
  await accountClient.restoreSession();
  return { accountClient, teacherClient, ClassroomError, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("teacher draft saves after the session changes", () => {
  it("retries once with the refreshed CSRF token after another tab signs in again", async () => {
    const { teacherClient, calls } = await editor(
      json(session),
      json({ error: "csrf_rejected" }, 403),
      json(rotatedSession),
      json(profile(2)),
    );
    const board = starterBoard();
    const saved = await teacherClient.save(profileId, 1, board);
    expect(saved.revision).toBe(2);
    expect(calls.map(({ request, csrf }) => ({ request, csrf }))).toEqual([
      { request: "GET /api/auth/session", csrf: undefined },
      { request: `PUT ${profilePath}`, csrf: session.csrfToken },
      { request: "GET /api/auth/session", csrf: undefined },
      { request: `PUT ${profilePath}`, csrf: rotatedSession.csrfToken },
    ]);
    expect(calls[3].body).toEqual({ revision: 1, board });
    expect(calls[3].body).toEqual(calls[1].body);
  });

  it("asks the teacher to sign in elsewhere when the session ended, then saves after they do", async () => {
    const { accountClient, teacherClient, ClassroomError, calls } =
      await editor(
        json(session),
        json({ error: "unauthenticated" }, 401),
        json({ error: "unauthenticated" }, 401),
        json({ error: "csrf_rejected" }, 403),
        json(rotatedSession),
        json(profile(2)),
      );
    const board = starterBoard();
    const original = structuredClone(board);
    const failure = teacherClient.save(profileId, 1, board);
    await expect(failure).rejects.toBeInstanceOf(ClassroomError);
    await expect(failure).rejects.toMatchObject({
      status: 401,
      message:
        "Your sign-in changed. Sign in on the teacher dashboard in another tab, then save this draft again.",
    });
    expect(calls.map(({ request }) => request)).toEqual([
      "GET /api/auth/session",
      `PUT ${profilePath}`,
      "GET /api/auth/session",
    ]);
    expect(accountClient.currentSession()).toBeNull();
    expect(board).toEqual(original);

    // The teacher signs in on the dashboard tab, which sets a new session cookie.
    const saved = await teacherClient.save(profileId, 1, board);
    expect(saved.revision).toBe(2);
    expect(
      calls.slice(3).map(({ request, csrf }) => ({ request, csrf })),
    ).toEqual([
      { request: `PUT ${profilePath}`, csrf: undefined },
      { request: "GET /api/auth/session", csrf: undefined },
      { request: `PUT ${profilePath}`, csrf: rotatedSession.csrfToken },
    ]);
  });

  it("does not refresh the session or retry other save failures", async () => {
    const { teacherClient, calls } = await editor(
      json(session),
      json({ error: "stale_revision" }, 409),
    );
    await expect(
      teacherClient.save(profileId, 1, starterBoard()),
    ).rejects.toMatchObject({ status: 409 });
    expect(calls.map(({ request }) => request)).toEqual([
      "GET /api/auth/session",
      `PUT ${profilePath}`,
    ]);
  });
});
