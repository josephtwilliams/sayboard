import { parseBoard, serializeBoard, type Board } from "./board";
import type {
  EmailPurpose,
  EmailInspection,
  EmailAvailability,
} from "./email-contract";
export type AccountSession = {
  account: { username: string };
  csrfToken: string;
  expiresAt: number;
  recoveryEligible: boolean;
  verifiedEmail: string | null;
};
export type AccountBoard = { board: Board | null; revision: number };
export type AccountAvailability =
  | { state: "disabled" }
  | {
      state: "enabled";
      signupEnabled: boolean;
      recoveryEnabled: boolean;
      signupMode: "username" | "verified-email";
      emailAvailability: EmailAvailability;
    };
export type RecoveryKit = { username: string; recoveryCode: string };
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
    recoveryEligible: value.recoveryEligible === true,
    verifiedEmail:
      typeof value.verifiedEmail === "string" ? value.verifiedEmail : null,
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
    let response: Response;
    try {
      response = await fetcher(path, {
        ...options,
        credentials: "same-origin",
      });
    } catch {
      throw new AccountError(
        0,
        "Account storage could not be reached. Your board remains on this device.",
      );
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) session = null;
      const failure: unknown = await response.json().catch(() => null);
      const code =
        object(failure) && typeof failure.error === "string"
          ? failure.error
          : "";
      const selfServiceMessages: Record<string, string> = {
        invalid_email: "Enter a valid email address.",
        email_unconfigured:
          "Email delivery is unavailable on this host. You can still sign in or use your recovery kit.",
        email_link_unavailable:
          "This link is expired, used, or unavailable for this account. Sign in or request another email.",
        username_unavailable:
          "That username is unavailable. Choose another username or sign in.",
        reserved_username: "Choose a different teacher username.",
        invalid_password: "Use a password between 16 and 256 characters.",
        current_password_incorrect:
          "Current password did not match. Try again.",
        invalid_credentials:
          "Use a username with 1 to 64 letters, numbers, underscores or hyphens.",
        recovery_failed:
          "The username, recovery code or password did not match. Try again.",
        invalid_recovery_code:
          "Enter the complete recovery code from your recovery kit.",
        signup_disabled:
          "New workspaces are not available on this host. You can still sign in or recover an existing account.",
        signup_capacity_reached:
          "This host has reached its workspace limit. Try again later or contact the host administrator.",
        too_many_attempts:
          "Too many attempts. Wait five minutes, then try again.",
      };
      const message =
        selfServiceMessages[code] ??
        (response.status === 409
          ? "The account board changed on another device. Review the latest board before choosing which version to keep."
          : response.status === 503
            ? "The account service is unavailable. Try again later. Your local board is unchanged."
            : response.status === 401
              ? "Sign-in failed or your session expired. Your local board is unchanged."
              : response.status === 403
                ? "This account request was rejected. Sign in again. Your local board is unchanged."
                : "The account request failed. Your local board is unchanged.");
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
          availability = {
            state: "enabled",
            signupEnabled: value.signupEnabled === true,
            recoveryEnabled: value.recoveryEnabled === true,
            signupMode:
              value.signupMode === "verified-email"
                ? "verified-email"
                : "username",
            emailAvailability:
              value.emailAvailability === "ready"
                ? "ready"
                : value.emailAvailability === "unsupported"
                  ? "unsupported"
                  : "unavailable",
          };
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
    async requestEmail(kind: EmailPurpose, email: string): Promise<void> {
      return operation(async () => {
        const result = await request(
          kind === "link" ? "/api/auth/email/link" : "/api/auth/email/request",
          {
            method: "POST",
            headers:
              kind === "link"
                ? mutationHeaders()
                : { "Content-Type": "application/json" },
            body: JSON.stringify({ kind, email }),
          },
        );
        if (!object(result) || result.kind !== "requested")
          throw new AccountError(
            502,
            "The email request response was invalid.",
          );
      });
    },
    async inspectEmail(token: string): Promise<EmailInspection> {
      return operation(async () => {
        const value = await request("/api/auth/email/inspect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (object(value)) {
          if (value.kind === "unavailable") return { kind: "unavailable" };
          if (typeof value.email === "string") {
            if (value.kind === "signup" || value.kind === "reset")
              return { kind: value.kind, email: value.email };
            if (value.kind === "link" && typeof value.username === "string")
              return {
                kind: "link",
                email: value.email,
                username: value.username,
              };
          }
        }
        throw new AccountError(502, "The email link response was invalid.");
      });
    },
    async completeEmail(
      kind: EmailPurpose,
      token: string,
      password: string,
    ): Promise<void> {
      return operation(async () => {
        const value = await request("/api/auth/email/complete", {
          method: "POST",
          headers:
            kind === "link"
              ? mutationHeaders()
              : { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, token, password }),
        });
        if (kind === "link") {
          if (!object(value) || value.kind !== "linked")
            throw new AccountError(
              502,
              "The email confirmation response was invalid.",
            );
        } else session = parseSession(value);
      });
    },
    async enterWorkspace(
      input:
        | { kind: "register"; username: string; password: string }
        | {
            kind: "recover";
            username: string;
            password: string;
            recoveryCode: string;
          },
    ): Promise<RecoveryKit> {
      return operation(async () => {
        const { kind, ...credentials } = input;
        const value = await request(`/api/auth/${kind}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(credentials),
        });
        session = parseSession(value);
        if (
          !object(value) ||
          typeof value.recoveryCode !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.recoveryCode)
        )
          throw new AccountError(
            502,
            "Your workspace may be ready. Sign in with your password and replace your recovery code.",
          );
        return {
          username: session.account.username,
          recoveryCode: value.recoveryCode,
        };
      });
    },
    async replaceRecoveryKit(password: string): Promise<RecoveryKit> {
      return operation(async () => {
        const value = await request("/api/auth/recovery-kit", {
          method: "POST",
          headers: mutationHeaders(),
          body: JSON.stringify({ password }),
        });
        if (
          !object(value) ||
          typeof value.username !== "string" ||
          typeof value.recoveryCode !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.recoveryCode)
        )
          throw new AccountError(
            502,
            "The recovery code could not be read. Replace it again with your password.",
          );
        return { username: value.username, recoveryCode: value.recoveryCode };
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
