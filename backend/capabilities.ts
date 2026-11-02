import { configuredMailer } from "./mail.js";
import type { ApiConfig } from "./config.js";
import { hostedConfig } from "./config.js";

export function accountCapabilities(
  config: ApiConfig | null,
  supported: boolean,
  mailReady: boolean,
) {
  const mode =
    config?.kind === "hosted"
      ? (config.teacherAccountMode ?? "username")
      : "username";
  const emailEnabled = config?.kind === "hosted" && supported && mailReady;
  return {
    signupMode: mode,
    signupEnabled:
      config?.kind === "hosted" &&
      config.signupEnabled === true &&
      supported &&
      (mode === "username" || emailEnabled),
    recoveryEnabled: config?.kind === "hosted" && supported,
    emailAvailability: !supported
      ? "unsupported"
      : emailEnabled
        ? "ready"
        : "unavailable",
  };
}
// Configuration discovery only. Enabled does not assert database health.
export function createHostedCapabilitiesHandler(env: NodeJS.ProcessEnv) {
  return async (request: Request): Promise<Response> => {
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (request.method !== "GET")
      return new Response('{"error":"method_not_allowed"}', {
        status: 405,
        headers: { ...headers, Allow: "GET" },
      });
    try {
      // A broken hosting boundary is never reported as deliberate disablement.
      if (env.NODE_ENV !== "production" || env.SAYBOARD_LOCAL_DEV)
        throw new Error("Invalid hosted runtime");
      const disabled = [undefined, "", "0"].includes(env.SAYBOARD_AUTH_ENABLED);
      const config = disabled ? null : hostedConfig(env);
      if (
        disabled &&
        env.SAYBOARD_SIGNUP_ENABLED &&
        env.SAYBOARD_SIGNUP_ENABLED !== "0"
      )
        throw new Error("Signup requires hosted authentication");
      return new Response(
        JSON.stringify({
          state: disabled ? "disabled" : "enabled",
          ...accountCapabilities(
            config,
            !disabled && env.SAYBOARD_STORAGE === "sqlite",
            configuredMailer(env) !== null,
          ),
        }),
        { status: 200, headers },
      );
    } catch {
      return new Response('{"error":"auth_unconfigured"}', {
        status: 503,
        headers,
      });
    }
  };
}
