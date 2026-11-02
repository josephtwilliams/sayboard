import { accountCapabilities } from "./capabilities.js";
import { body, HttpError, json, sessionToken } from "./api-http.js";
import { emitBackendFailure } from "./backend-errors.js";
import { deviceApi, teacherApi } from "./classroom-api.js";
import { parseBoard } from "../src/board.js";
import type { ApiConfig } from "./config.js";
import type { RegistrationInput, RecoveryInput } from "./self-service.js";
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
  options: { allowCrossSiteNavigation?: boolean } = {},
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
    (request.headers.get("sec-fetch-site") === "cross-site" &&
      !options.allowCrossSiteNavigation)
  )
    return json(403, { error: "origin_rejected" });
  return null;
}
type LoginIdentifier =
  { kind: "username"; value: string } | { kind: "email"; value: string };
function credentials(
  value: unknown,
  emailLogin = false,
): { username: string; password: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("username" in value) ||
    !("password" in value) ||
    typeof value.username !== "string" ||
    !(emailLogin && value.username.includes("@")
      ? value.username.length <= 254
      : /^[a-zA-Z0-9_-]{1,64}$/.test(value.username)) ||
    typeof value.password !== "string" ||
    value.password.length < 1 ||
    value.password.length > 256
  )
    throw new HttpError(400, "invalid_credentials");
  let username = value.username;
  if (emailLogin && username.includes("@")) {
    try {
      username = emailAddress(username);
    } catch {
      throw new HttpError(400, "invalid_email");
    }
  }
  return { username, password: value.password };
}
function registration(value: unknown): RegistrationInput {
  const input = credentials(value);
  if (input.password.length < 16) throw new HttpError(400, "invalid_password");
  if (
    Object.keys(typeof value === "object" && value !== null ? value : {}).some(
      (key) => !["username", "password", "recoveryCode"].includes(key),
    )
  )
    throw new HttpError(400, "invalid_credentials");
  return input;
}
function recovery(value: unknown): RecoveryInput {
  const input = registration(value);
  if (
    typeof value !== "object" ||
    value === null ||
    !("recoveryCode" in value) ||
    typeof value.recoveryCode !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.recoveryCode)
  )
    throw new HttpError(400, "invalid_recovery_code");
  return { ...input, recoveryCode: value.recoveryCode };
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
  if (config.kind === "hosted" && config.signupEnabled && !store.selfService)
    throw new Error("Self-service storage unavailable");
  const sessionBody = (
    username: string,
    token: string,
    expiresAt: number,
    recoveryEligible: boolean,
    verifiedEmail: string | null = null,
  ) => ({
    account: { username },
    csrfToken: csrfToken(token),
    expiresAt,
    recoveryEligible,
    verifiedEmail,
  });
  // Equal-cost verification for unknown usernames. Generated once at startup.
  const dummyHash = await hashPassword(newToken());
  let passwordChecks = 0;
  let mailSends = 0;
  const mailConcurrency = 2;
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
      if (["/api/auth/register", "/api/auth/recover"].includes(url.pathname)) {
        if (request.method !== "POST")
          throw new HttpError(405, "method_not_allowed", { Allow: "POST" });
        const selfService =
          config.kind === "hosted" ? store.selfService : undefined;
        if (!selfService) throw new HttpError(503, "self_service_unavailable");
        const registering = url.pathname === "/api/auth/register";
        if (
          registering &&
          !(
            config.kind === "hosted" &&
            config.signupEnabled &&
            config.teacherAccountMode !== "verified-email"
          )
        )
          throw new HttpError(403, "signup_disabled");
        if (
          !selfService.allowAttempt(peer, now()) ||
          passwordChecks >= passwordConcurrency
        )
          throw new HttpError(429, "too_many_attempts", {
            "Retry-After": "300",
          });
        const value = await body(request, 4096);
        const input:
          | (RegistrationInput & { kind: "register" })
          | (RecoveryInput & { kind: "recover" }) = registering
          ? { kind: "register", ...registration(value) }
          : { kind: "recover", ...recovery(value) };
        if (
          registering &&
          (/^admin$/i.test(input.username) ||
            /^teacher_(?:[a-f0-9]{16}|[a-f0-9]{32})$/i.test(input.username))
        )
          throw new HttpError(400, "reserved_username");
        if (passwordChecks >= passwordConcurrency)
          throw new HttpError(429, "too_many_attempts", {
            "Retry-After": "300",
          });
        passwordChecks++;
        try {
          const passwordHash = await hashPassword(input.password);
          const recoveryCode = newToken();
          const token = newToken();
          const expiresAt = now() + SESSION_SECONDS * 1000;
          const grant = {
            username: input.username,
            passwordHash,
            recoveryHash: tokenHash(recoveryCode),
            sessionHash: tokenHash(token),
            expiresAt,
          };
          if (input.kind === "recover")
            selfService.recover({
              ...grant,
              previousRecoveryHash: tokenHash(input.recoveryCode),
            });
          else
            selfService.register({
              ...grant,
              now: now(),
              capacity:
                config.kind === "hosted"
                  ? (config.publicAccountLimit ?? 100)
                  : 100,
            });
          const previous = sessionToken(request, cookieName);
          if (previous) await store.deleteSession(tokenHash(previous));
          const recoveredAccount = registering
            ? null
            : await store.account(input.username);
          return json(
            registering ? 201 : 200,
            {
              ...sessionBody(
                input.username,
                token,
                expiresAt,
                true,
                recoveredAccount
                  ? selfService.verifiedEmail(recoveredAccount.id)
                  : null,
              ),
              recoveryCode,
            },
            { "Set-Cookie": cookie(token, SESSION_SECONDS) },
          );
        } finally {
          passwordChecks--;
        }
      }
      if (url.pathname.startsWith("/api/auth/email/")) {
        if (request.method !== "POST")
          throw new HttpError(405, "method_not_allowed", { Allow: "POST" });
        const selfService =
          config.kind === "hosted" ? store.selfService : undefined;
        if (!selfService || config.kind !== "hosted")
          throw new HttpError(503, "self_service_unavailable");
        const input = await body(request, 4096);
        if (typeof input !== "object" || input === null)
          throw new HttpError(400, "invalid_email_request");
        const path = url.pathname;
        const requesting =
          path === "/api/auth/email/request" || path === "/api/auth/email/link";
        if (
          !requesting &&
          path !== "/api/auth/email/inspect" &&
          path !== "/api/auth/email/complete"
        )
          throw new HttpError(404, "not_found");
        const linking =
          path === "/api/auth/email/link" ||
          (path.endsWith("/complete") &&
            "kind" in input &&
            input.kind === "link");
        const currentToken = sessionToken(request, cookieName);
        const currentSession =
          linking && currentToken
            ? await store.session(tokenHash(currentToken), now())
            : null;
        if (
          linking &&
          (!currentToken ||
            !currentSession ||
            !selfService.eligible(currentSession.account.id))
        )
          throw new HttpError(401, "unauthenticated");
        if (
          linking &&
          !matchesToken(
            request.headers.get("x-csrf-token"),
            csrfToken(currentToken ?? ""),
          )
        )
          throw new HttpError(403, "csrf_rejected");
        if (requesting) {
          if (!mail) throw new HttpError(503, "email_unconfigured");
          const kind = linking ? "link" : "kind" in input ? input.kind : null;
          if (
            (!linking && kind !== "signup" && kind !== "reset") ||
            (kind !== "signup" && kind !== "reset" && kind !== "link")
          )
            throw new HttpError(400, "invalid_email_request");
          if (
            kind === "signup" &&
            (!config.signupEnabled ||
              config.teacherAccountMode !== "verified-email")
          )
            throw new HttpError(403, "signup_disabled");
          let email: string;
          try {
            email = emailAddress("email" in input ? input.email : null);
          } catch {
            throw new HttpError(400, "invalid_email");
          }
          if (mailSends >= mailConcurrency)
            throw new HttpError(429, "too_many_attempts", {
              "Retry-After": "60",
            });
          mailSends++;
          try {
            const proof = newToken();
            selfService.issueEmail({
              ...(kind === "link"
                ? { kind, sessionHash: tokenHash(currentToken ?? "") }
                : { kind }),
              email,
              tokenHash: tokenHash(proof),
              peer,
              now: now(),
            });
            try {
              await mail.send({
                kind: "email",
                purpose: kind,
                to: email,
                url: `${config.origin}/teacher#email=${proof}`,
                expiresAt: now() + 30 * 60_000,
              });
            } catch {
              emitBackendFailure("email_delivery_failed");
            }
            return json(202, { kind: "requested", retryAfterSeconds: 60 });
          } finally {
            mailSends--;
          }
        }
        if (!selfService.allowAttempt(`email:${peer}`, now()))
          throw new HttpError(429, "too_many_attempts");
        if (
          !("token" in input) ||
          typeof input.token !== "string" ||
          !/^[a-f0-9]{64}$/.test(input.token)
        )
          throw new HttpError(400, "email_link_unavailable");
        const hash = tokenHash(input.token);
        const view = selfService.inspectEmail(hash, now());
        if (path.endsWith("/inspect")) return json(200, view);
        if (
          !("kind" in input) ||
          view.kind === "unavailable" ||
          input.kind !== view.kind
        )
          throw new HttpError(400, "email_link_unavailable");
        if (
          view.kind === "signup" &&
          (!config.signupEnabled ||
            config.teacherAccountMode !== "verified-email" ||
            !mail)
        )
          throw new HttpError(403, "signup_disabled");
        if (
          !("password" in input) ||
          typeof input.password !== "string" ||
          input.password.length < 16 ||
          input.password.length > 256
        )
          throw new HttpError(400, "invalid_password");
        if (passwordChecks >= passwordConcurrency)
          throw new HttpError(429, "too_many_attempts");
        passwordChecks++;
        try {
          if (view.kind === "link") {
            if (
              !currentSession ||
              !currentToken ||
              !(await verifyPassword(
                input.password,
                currentSession.account.passwordHash,
              ))
            )
              throw new HttpError(400, "current_password_incorrect");
            selfService.completeEmail({
              kind: "link",
              tokenHash: hash,
              now: now(),
              sessionHash: tokenHash(currentToken),
              verifiedPasswordHash: currentSession.account.passwordHash,
            });
            return json(200, { kind: "linked" });
          }
          const passwordHash = await hashPassword(input.password);
          const token = newToken();
          const expiresAt = now() + SESSION_SECONDS * 1000;
          const username = selfService.completeEmail({
            kind: view.kind,
            tokenHash: hash,
            now: now(),
            passwordHash,
            sessionHash: tokenHash(token),
            expiresAt,
            capacity: config.publicAccountLimit ?? 100,
          });
          if (currentToken) await store.deleteSession(tokenHash(currentToken));
          return json(
            200,
            sessionBody(username, token, expiresAt, true, view.email),
            {
              "Set-Cookie": cookie(token, SESSION_SECONDS),
            },
          );
        } finally {
          passwordChecks--;
        }
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
        "/api/auth/recovery-kit",
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
        return json(200, {
          state: "enabled",
          ...accountCapabilities(config, !!store.selfService, mail !== null),
        });
      if (url.pathname === "/api/auth/login") {
        const input = credentials(await body(request), true);
        if (
          !(await store.allowLogin(peer, now())) ||
          passwordChecks >= passwordConcurrency
        )
          return json(
            429,
            { error: "too_many_attempts" },
            { "Retry-After": "300" },
          );
        // Reserve synchronously before account lookup so concurrent requests cannot
        // pass the cap together while a future database adapter is awaiting I/O.
        passwordChecks++;
        let account;
        let valid: boolean;
        try {
          const identifier: LoginIdentifier = input.username.includes("@")
            ? { kind: "email", value: input.username }
            : { kind: "username", value: input.username };
          const username =
            identifier.kind === "email"
              ? store.selfService?.emailUsername(identifier.value)
              : identifier.value;
          account = username ? await store.account(username) : null;
          valid = await verifyPassword(
            input.password,
            account?.passwordHash.startsWith("scrypt$")
              ? account.passwordHash
              : dummyHash,
          );
        } finally {
          passwordChecks--;
        }
        if (
          !valid ||
          !account ||
          !account.passwordHash.startsWith("scrypt$") ||
          !allowedAccount(account) ||
          (config.kind === "hosted" && input.password.length < 16)
        )
          throw new HttpError(401, "login_failed");
        // Rotate the browser's previous session at every successful login.
        const previous = sessionToken(request, cookieName);
        if (previous) await store.deleteSession(tokenHash(previous));
        const token = newToken();
        const expiresAt = now() + SESSION_SECONDS * 1000;
        if (
          !(await store.createPasswordSession(
            tokenHash(token),
            account.id,
            account.passwordHash,
            expiresAt,
          ))
        )
          throw new HttpError(401, "login_failed");
        return json(
          200,
          sessionBody(
            account.username,
            token,
            expiresAt,
            config.kind === "hosted" &&
              !!store.selfService?.eligible(account.id),
            store.selfService?.verifiedEmail(account.id) ?? null,
          ),
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
        return json(
          200,
          sessionBody(
            session.account.username,
            token,
            session.expiresAt,
            config.kind === "hosted" &&
              !!store.selfService?.eligible(session.account.id),
            store.selfService?.verifiedEmail(session.account.id) ?? null,
          ),
        );
      if (url.pathname === "/api/auth/recovery-kit") {
        const selfService =
          config.kind === "hosted" ? store.selfService : undefined;
        if (!selfService || !selfService.eligible(session.account.id))
          throw new HttpError(403, "recovery_unavailable");
        if (!selfService.allowAttempt(peer, now()))
          throw new HttpError(429, "too_many_attempts", {
            "Retry-After": "300",
          });
        const input = await body(request, 4096);
        if (
          typeof input !== "object" ||
          input === null ||
          !("password" in input) ||
          typeof input.password !== "string" ||
          input.password.length < 16 ||
          input.password.length > 256 ||
          Object.keys(input).length !== 1
        )
          throw new HttpError(400, "invalid_password");
        if (passwordChecks >= passwordConcurrency)
          throw new HttpError(429, "too_many_attempts", {
            "Retry-After": "300",
          });
        passwordChecks++;
        try {
          if (
            !(await verifyPassword(
              input.password,
              session.account.passwordHash,
            ))
          )
            throw new HttpError(400, "current_password_incorrect");
          const recoveryCode = newToken();
          selfService.replace({
            accountId: session.account.id,
            verifiedPasswordHash: session.account.passwordHash,
            recoveryHash: tokenHash(recoveryCode),
          });
          return json(200, {
            recoveryCode,
            username: session.account.username,
          });
        } finally {
          passwordChecks--;
        }
      }
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
      emitBackendFailure("account_request_failed");
      // Do not leak SQL, filesystem paths, submitted boards, passwords or tokens.
      return json(503, { error: "storage_unavailable" });
    }
  };
}
