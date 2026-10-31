import { isIP } from "node:net";
import { emitBackendFailure } from "./backend-errors.js";
import { hostedConfig } from "./config.js";
import { createApi, requestRejection } from "./api.js";
import { tokenHash } from "./password.js";
import type { Store } from "./store-contract.js";
import { smtpMailer } from "./mail.js";
import {
  createGoogleHandler,
  googleConfig,
  isGoogleCallback,
} from "./google.js";

const unavailable = (error: string) =>
  new Response(JSON.stringify({ error }), {
    status: 503,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

export function createHostedHandler(
  env: NodeJS.ProcessEnv,
  getStore: () => Promise<Store>,
  now = Date.now,
) {
  let pending:
    | Promise<{
        api: Awaited<ReturnType<typeof createApi>>;
        google: ReturnType<typeof createGoogleHandler>;
      }>
    | undefined;
  let initializedOrigin: string | undefined;
  return async (request: Request, clientIp: string): Promise<Response> => {
    let config;
    try {
      config = hostedConfig(env);
    } catch {
      return unavailable("auth_unconfigured");
    }
    // The HTTP adapter supplies a client IP only after validating its proxy peer.
    const ip = clientIp;
    if (!ip || !isIP(ip)) return unavailable("trusted_peer_unavailable");
    const peer = tokenHash(`sayboard-peer:${ip.toLowerCase()}`);
    const rejection = requestRejection(request, peer, config, {
      allowCrossSiteNavigation: isGoogleCallback(request),
    });
    if (rejection) return rejection;
    if (pending && initializedOrigin !== config.origin)
      return unavailable("auth_unconfigured");
    initializedOrigin = config.origin;
    pending ??= Promise.resolve()
      .then(getStore)
      .then(async (store) => ({
        api: await createApi(store, config, now, smtpMailer(env)),
        google: createGoogleHandler(store, config, googleConfig(env), now),
      }));
    const attempt = pending;
    try {
      const handlers = await attempt;
      return new URL(request.url).pathname.startsWith("/api/auth/google/")
        ? await handlers.google(request, peer)
        : await handlers.api(request, peer);
    } catch {
      if (pending === attempt) pending = undefined;
      emitBackendFailure("hosted_handler_failed");
      return unavailable("storage_unavailable");
    }
  };
}
