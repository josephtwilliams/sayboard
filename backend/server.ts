import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { isIP } from "node:net";
import { localServer } from "./http.js";
import { hostedConfig } from "./config.js";
import { createHostedHandler } from "./hosted.js";
import { createHostedCapabilitiesHandler } from "./capabilities.js";
import { SqliteStore } from "./store.js";
import { productionStoreFactory } from "./postgres-runtime.js";
import { retainSources } from "./source-retention.js";
import { sessionToken } from "./api-http.js";
import { smtpMailer } from "./mail.js";
import { googleConfig } from "./google.js";

const json = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".gz": "application/gzip",
  ".webmanifest": "application/manifest+json",
};

export async function startServer(env: NodeJS.ProcessEnv) {
  if (env.NODE_ENV !== "production" || env.SAYBOARD_LOCAL_DEV)
    throw new Error("Production settings required");
  const port = Number(env.SAYBOARD_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid server port");
  const enabled = env.SAYBOARD_AUTH_ENABLED === "1";
  if (![undefined, "", "0", "1"].includes(env.SAYBOARD_AUTH_ENABLED))
    throw new Error("Invalid account setting");
  const publicURL = new URL(env.SAYBOARD_ORIGIN ?? `http://127.0.0.1:${port}`);
  if (
    !["http:", "https:"].includes(publicURL.protocol) ||
    publicURL.username ||
    publicURL.password ||
    publicURL.pathname !== "/" ||
    publicURL.search ||
    publicURL.hash ||
    (publicURL.protocol === "http:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(publicURL.hostname))
  )
    throw new Error(
      "Use an exact HTTPS origin, or HTTP loopback for local verification",
    );
  const origin = publicURL.origin;
  if (enabled) {
    hostedConfig(env);
    // Invalid optional email settings must stop startup, not turn every account request into a 503.
    smtpMailer(env);
  }
  // Reject partial credentials and unsupported storage before accepting traffic.
  googleConfig(env);
  const directory = await realpath(resolve(env.SAYBOARD_STATIC_DIR ?? "dist"));
  await readFile(resolve(directory, "index.html"));
  process.umask(0o077);
  const retainedSources = resolve(env.SAYBOARD_DATA_DIR ?? "data", "source");
  await retainSources(resolve(directory, "source"), retainedSources);
  // Served files are compared after realpath, so the base must be resolved too.
  const sourceDirectory = await realpath(retainedSources);
  let sqlite: SqliteStore | undefined;
  const getStore =
    env.SAYBOARD_STORAGE === "postgres"
      ? productionStoreFactory(env)
      : async () => {
          if (!sqlite)
            sqlite = new SqliteStore(env.SAYBOARD_DATABASE_PATH ?? "");
          return sqlite;
        };
  // Validate storage at startup when enabled; never seed a demonstration account.
  if (enabled) await getStore();
  const accounts = createHostedHandler(env, getStore);
  const capabilities = createHostedCapabilitiesHandler(env);
  const server = localServer(async (request, peer) => {
    const url = new URL(request.url);
    let response: Response;
    if (
      request.headers.get("host") !== new URL(origin).host ||
      url.origin !== origin
    ) {
      response = json(403, "host_rejected");
    } else if (url.pathname === "/healthz" && request.method === "GET") {
      response = new Response('{"ok":true}', {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    } else if (url.pathname === "/api/auth/capabilities") {
      response = await capabilities(request);
    } else if (url.pathname.startsWith("/api/")) {
      const forwarded = request.headers.get("x-forwarded-for") ?? "";
      const trusted = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer);
      response =
        !trusted ||
        !isIP(forwarded) ||
        request.headers.get("x-forwarded-proto") !== "https"
          ? json(403, "proxy_rejected")
          : await accounts(request, forwarded);
    } else if (!["GET", "HEAD"].includes(request.method)) {
      response = json(405, "method_not_allowed");
    } else if (["/teacher.html", "/teacher/"].includes(url.pathname)) {
      response = new Response(null, {
        status: 308,
        headers: {
          Location: "/teacher" + url.search,
          "Cache-Control": "no-cache",
        },
      });
    } else {
      try {
        const decoded = decodeURIComponent(url.pathname);
        const path =
          decoded === "/teacher"
            ? "/teacher.html"
            : decoded.endsWith("/")
              ? decoded + "index.html"
              : decoded;
        if (
          path.includes("\\") ||
          path.split("/").some((part) => part.startsWith("."))
        )
          throw new Error("Invalid path");
        const base = path.startsWith("/source/") ? sourceDirectory : directory;
        const relative = path.startsWith("/source/")
          ? path.slice("/source".length)
          : path;
        const file = await realpath(resolve(base, "." + relative));
        if (!file.startsWith(base + sep) || !(await stat(file)).isFile())
          throw new Error("Invalid file");
        const chunks =
          request.method === "HEAD"
            ? null
            : createReadStream(file)[Symbol.asyncIterator]();
        const body =
          chunks &&
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              const chunk = await chunks.next();
              if (chunk.done) controller.close();
              else if (chunk.value instanceof Uint8Array)
                controller.enqueue(chunk.value);
              else controller.error(new Error("Invalid file stream"));
            },
            async cancel() {
              await chunks.return?.();
            },
          });
        response = new Response(body, {
          headers: {
            "Content-Type": types[extname(file)] ?? "application/octet-stream",
            "Cache-Control":
              path.startsWith("/assets/") || path.endsWith(".tar.gz")
                ? "public, max-age=31536000, immutable"
                : "no-cache",
          },
        });
        if (enabled && path === "/index.html") {
          // This readable flag only resumes sync. The HttpOnly token still authenticates every request.
          const linked =
            sessionToken(request, "__Host-sayboard_device") !== null;
          response.headers.set("Cache-Control", "private, no-store");
          response.headers.set(
            "Set-Cookie",
            `sayboard_classroom=${linked ? "1" : ""}; Path=/; SameSite=Strict; Max-Age=${linked ? 30 * 24 * 60 * 60 : 0}; Secure`,
          );
        }
      } catch {
        response = json(404, "not_found");
      }
    }
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    return response;
  }, origin);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const shutdown = () => {
    server.close();
    server.closeIdleConnections();
  };
  server.once("close", () => {
    sqlite?.close();
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
  });
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}

if (process.env.SAYBOARD_SERVER_ENTRY === "1") {
  void startServer(process.env)
    .then(() => console.log("Sayboard server started on loopback."))
    .catch(() => {
      console.error(
        "Sayboard could not start. Check its origin, storage and email configuration and built static files.",
      );
      process.exitCode = 1;
    });
}
