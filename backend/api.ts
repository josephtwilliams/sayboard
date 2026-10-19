import { body, HttpError, json, sessionToken } from "./api-http.js";
import { deviceApi, teacherApi } from "./classroom-api.js";
import { parseBoard } from "../src/board.js";
import type { ApiConfig } from "./config.js";
import type { Store } from "./store-contract.js";
import { emailAddress, type Mailer } from "./mail.js";
import {
  csrfToken,
  hashPassword,
  matchesToken,
  newToken,
  tokenHash,
  verifyPassword,
} from "./password.js";

export const SESSION_SECONDS = 8 * 60 * 60;
// Run this before connecting to storage as well as within the authenticated API.
export function requestRejection(
  request: Request,
  peer: string,
  config: ApiConfig,
): Response | null {
  const url = new URL(request.url);
  if (config.kind === "local") {
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer) ||
      ![config.origin, config.apiOrigin].includes(url.origin) ||
      [...request.headers.keys()].some(
        (key) => key === "forwarded" || key.startsWith("x-forwarded-"),
      )
    )
      return json(403, { error: "local_only" });
  } else {
    const expectedHost = new URL(config.origin).host;
    if (
      url.origin !== config.origin ||
      (request.headers.has("host") &&
        request.headers.get("host") !== expectedHost) ||
      (request.headers.has("x-forwarded-host") &&
        request.headers.get("x-forwarded-host") !== expectedHost) ||
      (request.headers.has("x-forwarded-proto") &&
        request.headers.get("x-forwarded-proto") !== "https")
    )
      return json(403, { error: "origin_rejected" });
  }
  const origin = request.headers.get("origin");
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (
    (origin !== null && origin !== config.origin) ||
    (mutating && origin !== config.origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return json(403, { error: "origin_rejected" });
  return null;
}
function credentials(value: unknown): { username: string; password: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("username" in value) ||
    !("password" in value) ||
    typeof value.username !== "string" ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(value.username) ||
    typeof value.password !== "string" ||
    value.password.length < 1 ||
    value.password.length > 256
  )
    throw new HttpError(400, "invalid_credentials");
  return { username: value.username, password: value.password };
}
function boardWrite(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("board" in value) ||
    !("revision" in value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  )
    throw new HttpError(400, "invalid_board");
  try {
    return { board: parseBoard(value.board), revision: value.revision };
  } catch {
    throw new HttpError(400, "invalid_board");
  }
}

export async function createApi(
  store: Store,
  config: ApiConfig,
  now = Date.now,
  mail: Mailer | null = null,
) {
  const cookieName =
    config.kind === "hosted" ? "__Host-sayboard_session" : "sayboard_session";
  const cookie = (token: string, seconds: number) =>
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${config.kind === "hosted" ? "; Secure" : ""}`;
  const allowedAccount = (account: { username: string; localOnly: boolean }) =>
    config.kind === "local"
      ? account.localOnly
      : !account.localOnly && account.username.toLowerCase() !== "admin";
  // Equal-cost verification for unknown usernames. Generated once at startup.
  const dummyHash = await hashPassword(newToken());
  let passwordChecks = 0;
  const passwordConcurrency =
    config.kind === "hosted" ? (config.passwordConcurrency ?? 2) : 2;
  return async (request: Request, peer: string): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const rejection = requestRejection(request, peer, config);
      if (rejection) return rejection;
      const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
      if (url.search) throw new HttpError(400, "query_not_supported");
      if (
        ["/api/auth/activation", "/api/auth/activation/inspect"].includes(
          url.pathname,
        )
      ) {
        if (request.method !== "POST")
          throw new HttpError(405, "method_not_allowed", { Allow: "POST" });
        if (!store.onboarding)
          throw new HttpError(503, "onboarding_unavailable");
        if (!(await store.allowLogin(`activation:${peer}`, now())))
          return json(
            429,
            { error: "too_many_attempts" },
            { "Retry-After": "300" },
          );
        const input = await body(request);
        if (
          typeof input !== "object" ||
          input === null ||
          !("token" in input) ||
          typeof input.token !== "string" ||
          !/^[a-f0-9]{64}$/.test(input.token)
        )
          throw new HttpError(400, "invalid_invitation");
        const hash = tokenHash(input.token);
        const invitation = store.onboarding.inspect(hash, now());
        if (url.pathname.endsWith("/inspect")) return json(200, invitation);
        if (
          !("password" in input) ||
          typeof input.password !== "string" ||
          input.password.length < 16 ||
          input.password.length > 256
        )
          throw new HttpError(400, "invalid_password");
        if (passwordChecks >= passwordConcurrency)
          return json(
            429,
            { error: "too_many_attempts" },
            { "Retry-After": "300" },
          );
        passwordChecks++;
        try {
          store.onboarding.accept(
            hash,
            await hashPassword(input.password),
            now(),
          );
        } finally {
          passwordChecks--;
        }
        return json(200, { ok: true, username: invitation.username });
      }
      if (url.pathname.startsWith("/api/device/"))
        return await deviceApi(request, store, config, peer, now());
      const classroomRequest =
        url.pathname === "/api/classrooms" ||
        url.pathname.startsWith("/api/classrooms/") ||
        url.pathname.startsWith("/api/profiles/");
      const known = [
        "/api/auth/capabilities",
        "/api/auth/login",
        "/api/auth/session",
        "/api/auth/logout",
        "/api/board",
        "/api/invitations",
      ];
      if (!known.includes(url.pathname) && !classroomRequest)
        throw new HttpError(404, "not_found");
      const allowed =
        url.pathname === "/api/invitations"
          ? ["GET", "POST", "DELETE"]
          : url.pathname === "/api/board"
            ? ["GET", "PUT"]
            : ["/api/auth/session", "/api/auth/capabilities"].includes(
                  url.pathname,
                )
              ? ["GET"]
              : ["POST"];
      if (!classroomRequest && !allowed.includes(request.method))
        return json(
          405,
          { error: "method_not_allowed" },
          { Allow: allowed.join(", ") },
        );
      if (url.pathname === "/api/auth/capabilities")
        return json(200, { state: "enabled" });
      if (url.pathname === "/api/auth/login") {
        const input = credentials(await body(request));
        const tooMany = () =>
          json(429, { error: "too_many_attempts" }, { "Retry-After": "300" });
        // A request turned away only because a password check is already running
        // does no scrypt work, so it must not spend the shared peer budget.
        if (passwordChecks >= passwordConcurrency) return tooMany();
        // Check the budget without a slot, so a peer over its budget cannot keep
        // the slots busy for everyone else while a database answers.
        if (!(await store.allowLogin(peer, now()))) return tooMany();
        // Reserve synchronously after the last await so concurrent requests
        // cannot pass the cap together.
        if (passwordChecks >= passwordConcurrency) return tooMany();
        passwordChecks++;
        let account;
        let valid: boolean;
        try {
          account = await store.account(input.username);
          valid = await verifyPassword(
            input.password,
            account?.passwordHash ?? dummyHash,
          );
        } finally {
          passwordChecks--;
        }
        if (
          !valid ||
          !account ||
          !allowedAccount(account) ||
          (config.kind === "hosted" && input.password.length < 16)
        )
          throw new HttpError(401, "login_failed");
        // Rotate the browser's previous session at every successful login.
        const previous = sessionToken(request, cookieName);
        if (previous) await store.deleteSession(tokenHash(previous));
        const token = newToken();
        const expiresAt = now() + SESSION_SECONDS * 1000;
        await store.createSession(tokenHash(token), account.id, expiresAt);
        return json(
          200,
          {
            account: { username: account.username },
            csrfToken: csrfToken(token),
            expiresAt,
          },
          { "Set-Cookie": cookie(token, SESSION_SECONDS) },
        );
      }
      const token = sessionToken(request, cookieName);
      const session = token
        ? await store.session(tokenHash(token), now())
        : null;
      if (!token || !session || !allowedAccount(session.account))
        return json(
          401,
          { error: "unauthenticated" },
          { "Set-Cookie": cookie("", 0) },
        );
      if (
        mutating &&
        !matchesToken(request.headers.get("x-csrf-token"), csrfToken(token))
      )
        throw new HttpError(403, "csrf_rejected");
      if (url.pathname === "/api/auth/session")
        return json(200, {
          account: { username: session.account.username },
          csrfToken: csrfToken(token),
          expiresAt: session.expiresAt,
        });
      if (url.pathname === "/api/auth/logout") {
        await store.deleteSession(tokenHash(token));
        return json(200, { ok: true }, { "Set-Cookie": cookie("", 0) });
      }
      if (url.pathname === "/api/invitations") {
        const onboarding = store.onboarding;
        const operator = !!onboarding?.isOperator(session.account.id);
        if (request.method === "GET")
          return json(200, { operator, emailEnabled: mail !== null });
        if (!onboarding || !operator)
          throw new HttpError(403, "operator_required");
        if (!(await store.allowLogin(`invite:${session.account.id}`, now())))
          return json(
            429,
            { error: "too_many_attempts" },
            { "Retry-After": "300" },
          );
        const input = await body(request);
        if (request.method === "DELETE") {
          if (
            typeof input !== "object" ||
            input === null ||
            !("username" in input) ||
            typeof input.username !== "string" ||
            !/^[a-zA-Z0-9_-]{1,64}$/.test(input.username)
          )
            throw new HttpError(400, "invalid_invitation");
          onboarding.cancel(session.account.id, input.username);
          return json(200, { ok: true });
        }
        if (
          typeof input !== "object" ||
          input === null ||
          !("username" in input) ||
          typeof input.username !== "string" ||
          !/^[a-zA-Z0-9_-]{1,64}$/.test(input.username) ||
          input.username.toLowerCase() === "admin" ||
          !("kind" in input) ||
          (input.kind !== "invite" && input.kind !== "reset") ||
          ("delivery" in input &&
            input.delivery !== "email" &&
            input.delivery !== "link")
        )
          throw new HttpError(400, "invalid_invitation");
        const token = newToken();
        let email: string | null = null;
        if ("delivery" in input && input.delivery === "email") {
          if (!mail) throw new HttpError(503, "email_unconfigured");
          try {
            email = emailAddress("email" in input ? input.email : undefined);
          } catch {
            throw new HttpError(400, "invalid_email");
          }
        }
        const invitation = onboarding.issue(
          session.account.id,
          input.username,
          email,
          input.kind,
          tokenHash(token),
          now(),
        );
        const url = `${config.origin}/teacher#activate=${token}`;
        let emailStatus: "not_requested" | "accepted" | "failed" =
          "not_requested";
        if (email && mail) {
          try {
            await mail.send({ ...invitation, to: email, url });
            emailStatus = "accepted";
          } catch {
            emailStatus = "failed";
          }
        }
        return json(201, {
          ...invitation,
          url,
          emailStatus,
        });
      }
      if (classroomRequest)
        return await teacherApi(
          request,
          store.classrooms,
          session.account.id,
          now(),
        );
      // Owner comes exclusively from the server-side session, never client input.
      if (request.method === "GET")
        return json(
          200,
          (await store.board(session.account.id)) ?? {
            board: null,
            revision: 0,
          },
        );
      const input = boardWrite(await body(request));
      const saved = await store.saveBoard(
        session.account.id,
        input.board,
        input.revision,
      );
      if (!saved) throw new HttpError(409, "revision_conflict");
      return json(200, saved);
    } catch (error) {
      if (error instanceof HttpError)
        return json(error.status, { error: error.code }, error.headers);
      // Do not leak SQL, filesystem paths, submitted boards, passwords or tokens.
      return json(503, { error: "storage_unavailable" });
    }
  };
}
