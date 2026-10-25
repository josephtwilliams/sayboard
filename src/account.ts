import { parseBoard, serializeBoard, type Board } from "./board";
export type AccountSession = {
  account: { username: string };
  csrfToken: string;
  expiresAt: number;
};
export type AccountBoard = { board: Board | null; revision: number };
export type AccountAvailability = { state: "disabled" } | { state: "enabled" };
export const disabledAccountMessage =
  "Account backup is not enabled on this host. You can keep using and saving your board on this device.";
export class AccountError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function parseSession(value: unknown): AccountSession {
  if (
    !object(value) ||
    !object(value.account) ||
    typeof value.account.username !== "string" ||
    !value.account.username ||
    typeof value.csrfToken !== "string" ||
    !value.csrfToken ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt)
  )
    throw new AccountError(
      502,
      "The account response was invalid. Your local board is unchanged.",
    );
  return {
    account: { username: value.account.username },
    csrfToken: value.csrfToken,
    expiresAt: value.expiresAt,
  };
}
function parseAccountBoard(value: unknown): AccountBoard {
  if (
    !object(value) ||
    !("board" in value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  )
    throw new AccountError(
      502,
      "The account board response was invalid. Your local board is unchanged.",
    );
  try {
    return {
      board: value.board === null ? null : parseBoard(value.board),
      revision: value.revision,
    };
  } catch {
    throw new AccountError(
      502,
      "The account board could not be read. Your local board is unchanged.",
    );
  }
}
/** Browser-managed cookies. Session and CSRF state remain in memory only. */
export function createAccountClient(fetcher: typeof fetch = fetch) {
  let session: AccountSession | null = null;
  let availability: AccountAvailability | null = null;
  let capabilityRequest: Promise<AccountAvailability> | null = null;
  let sessionCheck: Promise<AccountSession | null> | null = null;
  let pending = false;
  async function operation<T>(run: () => Promise<T>): Promise<T> {
    if (availability?.state === "disabled")
      throw new AccountError(503, disabledAccountMessage);
    if (pending)
      throw new AccountError(
        0,
        "An account request is already in progress. Wait for it to finish, then try again.",
      );
    pending = true;
    try {
      return await run();
    } finally {
      pending = false;
    }
  }
  async function request(
    path: string,
    options: RequestInit = {},
  ): Promise<unknown> {
    // Safari versions without AbortSignal.timeout still support AbortController.
    // Keep the fallback alive through response-body parsing, and always release it.
    const controller =
      typeof AbortSignal.timeout === "function" ? null : new AbortController();
    const timer = controller
      ? setTimeout(() => controller.abort(), 20_000)
      : undefined;
    try {
      const signal = controller?.signal ?? AbortSignal.timeout(20_000);
      let response: Response;
      try {
        response = await fetcher(path, {
          ...options,
          credentials: "same-origin",
          signal,
        });
      } catch {
        throw new AccountError(
          0,
          "Account storage could not be reached. Your board remains on this device.",
        );
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) session = null;
        const message =
          response.status === 409
            ? "The account board changed on another device. Review the latest board before choosing which version to keep."
            : response.status === 503
              ? "The account service is unavailable. Try again later. Your local board is unchanged."
              : response.status === 401
                ? "Sign-in failed or your session expired. Your local board is unchanged."
                : response.status === 403
                  ? "This account request was rejected. Sign in again. Your local board is unchanged."
                  : "The account request failed. Your local board is unchanged.";
        throw new AccountError(response.status, message);
      }
      try {
        return await response.json();
      } catch {
        throw new AccountError(
          502,
          "The account response was invalid. Your local board is unchanged.",
        );
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function mutationHeaders() {
    if (!session)
      throw new AccountError(401, "Sign in before saving to your account.");
    return {
      "Content-Type": "application/json",
      "X-CSRF-Token": session.csrfToken,
    };
  }
  return {
    currentSession: () => session,
    currentAvailability: () => availability,
    async checkAvailability({ refresh = false } = {}) {
      if (capabilityRequest) return capabilityRequest;
      if (availability && !refresh) return availability;
      if (pending)
        throw new AccountError(
          0,
          "An account request is already in progress. Wait for it to finish, then try again.",
        );
      availability = null;
      capabilityRequest = (async (): Promise<AccountAvailability> => {
        const value = await request("/api/auth/capabilities", {
          cache: "no-store",
        });
        if (
          !object(value) ||
          (value.state !== "disabled" && value.state !== "enabled")
        )
          throw new AccountError(
            502,
            "The account availability response was invalid. Your local board is unchanged.",
          );
        if (value.state === "disabled") {
          session = null;
          availability = { state: "disabled" };
        } else {
          availability = { state: "enabled" };
        }
        return availability;
      })();
      try {
        return await capabilityRequest;
      } finally {
        capabilityRequest = null;
      }
    },
    async restoreSession() {
      return operation(async () => {
        try {
          session = parseSession(await request("/api/auth/session"));
        } catch (error) {
          session = null;
          if (!(error instanceof AccountError && error.status === 401))
            throw error;
        }
        return session;
      });
    },
    /** Checks the session once per page load, sharing any check in flight. */
    async checkSession() {
      if (!session)
        await (sessionCheck ??= this.restoreSession().catch((error) => {
          sessionCheck = null;
          throw error;
        }));
      return session;
    },
    async login(username: string, password: string) {
      return operation(async () => {
        session = null;
        session = parseSession(
          await request("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
          }),
        );
        return session;
      });
    },
    async logout() {
      return operation(async () => {
        await request("/api/auth/logout", {
          method: "POST",
          headers: mutationHeaders(),
        });
        session = null;
      });
    },
    async loadBoard() {
      return operation(async () =>
        parseAccountBoard(await request("/api/board")),
      );
    },
    async saveBoard(board: Board, revision: number) {
      return operation(async () => {
        if (!Number.isSafeInteger(revision) || revision < 0)
          throw new AccountError(
            400,
            "Review the account board before saving.",
          );
        const headers = mutationHeaders();
        const canonical = parseBoard(board);
        serializeBoard(canonical);
        return parseAccountBoard(
          await request("/api/board", {
            method: "PUT",
            headers,
            body: JSON.stringify({ board: canonical, revision }),
          }),
        );
      });
    },
  };
}
export const accountClient = createAccountClient();
