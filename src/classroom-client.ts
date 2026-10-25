import { accountClient } from "./account";
import { type Board } from "./board";
import {
  record,
  parseClassroom,
  parseClassroomDetail,
  parseProfileDetail,
  parseDeviceBoard,
  parseDeviceSync,
  integer,
  text,
} from "./classroom-contract";

export class ClassroomError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function request(
  path: string,
  method = "GET",
  payload?: unknown,
  deviceCsrf?: string,
): Promise<unknown> {
  const mutating = method !== "GET";
  const csrf = deviceCsrf ?? accountClient.currentSession()?.csrfToken;
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
      headers: mutating
        ? {
            "Content-Type": "application/json",
            ...(csrf ? { "X-CSRF-Token": csrf } : {}),
          }
        : {},
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  } catch {
    throw new ClassroomError(
      0,
      "The classroom service could not be reached. Your device board is unchanged. Try again when connected.",
    );
  }
  if (!response.ok) {
    const message =
      response.status === 401
        ? "Sign in again, or link this device with a new code. Your device board is unchanged."
        : response.status === 403
          ? "This request was rejected. Sign in again."
          : response.status === 404
            ? "This classroom, profile or board is no longer available."
            : response.status === 409
              ? "The draft changed in another tab, or a classroom limit was reached. Export unsaved work and refresh before trying again."
              : response.status === 429
                ? "Too many attempts. Wait five minutes before trying again."
                : response.status === 503
                  ? "Classroom hosting is unavailable on this server. Your device board is unchanged."
                  : "The classroom request failed. Your device board is unchanged.";
    throw new ClassroomError(response.status, message);
  }
  try {
    return await response.json();
  } catch {
    throw new ClassroomError(
      502,
      "The classroom service returned an unreadable response.",
    );
  }
}
function parsed<T>(parse: () => T): T {
  try {
    return parse();
  } catch {
    throw new ClassroomError(
      502,
      "The classroom service returned invalid data. Your device board is unchanged.",
    );
  }
}
const profilePath = (id: string) => `/api/profiles/${encodeURIComponent(id)}`;
const classroomPath = (id: string) =>
  `/api/classrooms/${encodeURIComponent(id)}`;
export const teacherClient = {
  async list() {
    const value = await request("/api/classrooms");
    return parsed(() => {
      const row = record(value);
      if (!Array.isArray(row.classrooms)) throw new Error("Invalid classrooms");
      return row.classrooms.map(parseClassroom);
    });
  },
  async create(name: string) {
    return parsedResult(
      await request("/api/classrooms", "POST", { name }),
      parseClassroom,
    );
  },
  async classroom(id: string) {
    return parsedResult(await request(classroomPath(id)), parseClassroomDetail);
  },
  async profile(id: string) {
    return parsedResult(await request(profilePath(id)), parseProfileDetail);
  },
  async addProfile(classroomId: string, label: string, board?: Board) {
    return parsedResult(
      await request(classroomPath(classroomId) + "/profiles", "POST", {
        label,
        board,
      }),
      parseProfileDetail,
    );
  },
  async save(id: string, revision: number, board: Board) {
    const send = () => request(profilePath(id), "PUT", { revision, board });
    let value: unknown;
    try {
      value = await send();
    } catch (error) {
      if (
        !(error instanceof ClassroomError) ||
        ![401, 403].includes(error.status)
      )
        throw error;
      // Signing in again from another tab rotates the CSRF token, and sessions
      // expire. Refresh once so the open draft can be saved without reloading.
      if (!(await accountClient.restoreSession()))
        throw new ClassroomError(
          401,
          "Your sign-in changed. Sign in on the teacher dashboard in another tab, then save this draft again.",
        );
      value = await send();
    }
    return parsedResult(value, parseProfileDetail);
  },
  async publish(id: string, revision: number) {
    return parsedResult(
      await request(profilePath(id) + "/publish", "POST", { revision }),
      parseProfileDetail,
    );
  },
  async restore(id: string, revision: number, version: number) {
    return parsedResult(
      await request(profilePath(id) + "/restore", "POST", {
        revision,
        version,
      }),
      parseProfileDetail,
    );
  },
  async removeProfile(id: string) {
    await request(profilePath(id), "DELETE");
  },
  async removeClassroom(id: string) {
    await request(classroomPath(id), "DELETE");
  },
  async pairing(id: string, name: string) {
    const value = await request(profilePath(id) + "/pairing", "POST", { name });
    return parsed(() => {
      const row = record(value);
      const code = text(row.code, 10);
      if (!/^[A-F0-9]{10}$/.test(code)) throw new Error("Invalid pairing code");
      return { code, expiresAt: integer(row.expiresAt) };
    });
  },
  async revoke(profileId: string, deviceId: string) {
    await request(
      profilePath(profileId) + "/devices/" + encodeURIComponent(deviceId),
      "DELETE",
    );
  },
};
function parsedResult<T>(value: unknown, parse: (value: unknown) => T): T {
  return parsed(() => parse(value));
}
export const deviceClient = {
  async sync() {
    return parsedResult(await request("/api/device/sync"), parseDeviceSync);
  },
  async applied(version: number, csrf: string) {
    await request("/api/device/applied", "POST", { version }, csrf);
  },
  async pair(code: string) {
    await request("/api/device/pair", "POST", { code });
  },
  async board() {
    return parsedResult(await request("/api/device/board"), parseDeviceBoard);
  },
  async unlink(csrf: string) {
    await request("/api/device/unlink", "POST", {}, csrf);
  },
};
