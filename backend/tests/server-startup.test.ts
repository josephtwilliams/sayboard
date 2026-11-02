import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, get } from "node:http";
import { expect, it } from "vitest";
import { startServer } from "../server.js";

async function availablePort() {
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const address = reservation.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test port");
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

it("keeps the server available with broken optional mail while closing verified signup", async () => {
  const root = await mkdtemp(join(tmpdir(), "sayboard-startup-"));
  const staticDirectory = join(root, "dist");
  await mkdir(join(staticDirectory, "source"), { recursive: true });
  await writeFile(join(staticDirectory, "index.html"), "<main>Board</main>");
  await writeFile(
    join(staticDirectory, "source", "history.json"),
    '{"releases":[]}',
  );
  await writeFile(join(staticDirectory, "source", "current.json"), "{}");
  await writeFile(join(staticDirectory, "source", "index.html"), "Sources");
  const env = async () => ({
    NODE_ENV: "production",
    SAYBOARD_AUTH_ENABLED: "1",
    SAYBOARD_SIGNUP_ENABLED: "1",
    SAYBOARD_TEACHER_ACCOUNT_MODE: "verified-email",
    SAYBOARD_STORAGE: "sqlite",
    SAYBOARD_DATABASE_PATH: join(root, "board.sqlite"),
    SAYBOARD_ORIGIN: "https://classroom.example.test",
    SAYBOARD_PORT: String(await availablePort()),
    SAYBOARD_STATIC_DIR: staticDirectory,
    SAYBOARD_DATA_DIR: join(root, "data"),
    SAYBOARD_SMTP_HOST: "smtp.example.test",
    SAYBOARD_SMTP_USER: "synthetic",
    SAYBOARD_SMTP_PASSWORD: "synthetic",
  });
  try {
    for (const from of [
      undefined,
      "Sayboard <accounts@example.test>",
      "accounts@example.test",
    ]) {
      const settings = { ...(await env()), SAYBOARD_EMAIL_FROM: from };
      const server = await startServer(settings);
      try {
        const response = await new Promise<{
          status: number | undefined;
          body: string;
        }>((resolve, reject) => {
          get(
            {
              hostname: "127.0.0.1",
              port: settings.SAYBOARD_PORT,
              path: "/api/auth/capabilities",
              headers: {
                Host: "classroom.example.test",
                "X-Forwarded-Proto": "https",
              },
            },
            (incoming) => {
              let body = "";
              incoming.setEncoding("utf8");
              incoming.on("data", (chunk) => {
                body += chunk;
              });
              incoming.on("end", () =>
                resolve({ status: incoming.statusCode, body }),
              );
            },
          ).on("error", reject);
        });
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toMatchObject({
          state: "enabled",
          signupEnabled: from === "accounts@example.test",
          signupMode: "verified-email",
          emailAvailability:
            from === "accounts@example.test" ? "ready" : "unavailable",
          recoveryEnabled: true,
        });
      } finally {
        server.closeIdleConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
