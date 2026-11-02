import { smtpCapture } from "./fixtures/smtp-capture.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { chromium, webkit, request } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "sayboard-email-browser-"));
const artifacts = join(root, "test-results/teacher-email");
await mkdir(artifacts, { recursive: true });
const port = Number(process.env.SAYBOARD_EMAIL_CHECK_PORT ?? 27443);
const appPort = port + 1;
const origin = `https://localhost:${port}`;
const databasePath = join(temporary, "sayboard.sqlite");
const password = "Synthetic self-service teacher password";
const nextPassword = "Synthetic changed self-service password";
const secrets = new Set([password, nextPassword]);
const env = {
  ...process.env,
  NODE_ENV: "production",
  SAYBOARD_SERVER_ENTRY: "1",
  SAYBOARD_ORIGIN: origin,
  SAYBOARD_PORT: String(appPort),
  SAYBOARD_STORAGE: "sqlite",
  SAYBOARD_DATABASE_PATH: databasePath,
  SAYBOARD_DATA_DIR: join(temporary, "data"),
  SAYBOARD_AUTH_ENABLED: "1",
  SAYBOARD_SIGNUP_ENABLED: "1",
  SAYBOARD_PUBLIC_ACCOUNT_LIMIT: "10",
  SAYBOARD_TEACHER_ACCOUNT_MODE: "verified-email",
};
for (const name of Object.keys(env))
  if (/^SAYBOARD_(GOOGLE|SMTP|EMAIL|LOCAL_DEV)/.test(name)) delete env[name];
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(temporary, "key.pem"),
    "-out",
    join(temporary, "cert.pem"),
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost",
    "-days",
    "1",
  ],
  { stdio: "ignore" },
);
Object.assign(env, {
  SAYBOARD_SMTP_HOST: "localhost",
  SAYBOARD_SMTP_PORT: String(port + 2),
  SAYBOARD_SMTP_USER: "synthetic",
  SAYBOARD_SMTP_PASSWORD: "synthetic-smtp-password",
  SAYBOARD_EMAIL_FROM: "sender@example.test",
  NODE_EXTRA_CA_CERTS: join(temporary, "cert.pem"),
});
const smtp = await smtpCapture({
  key: await readFile(join(temporary, "key.pem")),
  cert: await readFile(join(temporary, "cert.pem")),
  port: port + 2,
});
const proxy = createHttpsServer(
  {
    key: await readFile(join(temporary, "key.pem")),
    cert: await readFile(join(temporary, "cert.pem")),
  },
  (incoming, outgoing) => {
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: appPort,
        path: incoming.url,
        method: incoming.method,
        headers: {
          ...incoming.headers,
          host: `localhost:${port}`,
          "x-forwarded-host": `localhost:${port}`,
          "x-forwarded-proto": "https",
          "x-forwarded-for": "127.0.0.1",
        },
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  },
);
await new Promise((done, reject) => {
  proxy.once("error", reject);
  proxy.listen(port, "127.0.0.1", done);
});
let serverLog = "";
let app = spawn(process.execPath, ["server-dist/server.cjs"], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
app.stdout.on("data", (chunk) => (serverLog += chunk.toString()));
app.stderr.on("data", (chunk) => (serverLog += chunk.toString()));
const client = await request.newContext({
  baseURL: origin,
  ignoreHTTPSErrors: true,
});
let browser;
const report = {
  server:
    "emitted Node HTTPS server, real SQLite, STARTTLS SMTP with a trusted test CA",
  engines: [],
};
async function waitUntil(check, message) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.fail(message);
}
function mailLink(email) {
  const message = smtp.messages.findLast(
    (message) => message.recipient === email,
  );
  assert.ok(message, "SMTP captured the synthetic recipient");
  const raw = message.raw.replace(/=\r\n/g, "").replace(/=3D/g, "=");
  const token = raw.match(/#email=([a-f0-9]{64})/)?.[1];
  assert.ok(token, "SMTP contains the fragment proof");
  secrets.add(token);
  return origin + "/teacher#email=" + token;
}
async function privacy(page) {
  assert.equal(
    await page.evaluate(
      (values) =>
        values.some((value) =>
          JSON.stringify({
            local: { ...localStorage },
            session: { ...sessionStorage },
            url: location.href,
            state: history.state,
          }).includes(value),
        ),
      [...secrets],
    ),
    false,
  );
}
function clearLimits() {
  const db = new DatabaseSync(databasePath);
  db.exec(
    "DELETE FROM self_service_limits; DELETE FROM login_limits; DELETE FROM email_limits",
  );
  db.close();
}
async function requestEmail(page, button, email) {
  await page.getByRole("button", { name: button, exact: true }).click();
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page
    .getByRole("button", { name: "Send email link", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Check your email", exact: true })
    .waitFor();
}
async function stopApp() {
  if (app.exitCode === null && app.signalCode === null)
    await new Promise((done) => {
      app.once("exit", done);
      app.kill("SIGTERM");
    });
}
async function startApp(changes) {
  await stopApp();
  app = spawn(process.execPath, ["server-dist/server.cjs"], {
    cwd: root,
    env: { ...env, ...changes },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (chunk) => (serverLog += chunk.toString()));
  app.stderr.on("data", (chunk) => (serverLog += chunk.toString()));
  await waitUntil(async () => {
    try {
      return (await client.get("/healthz")).ok();
    } catch {
      return false;
    }
  }, "server restarts");
}
try {
  await waitUntil(async () => {
    try {
      return (await client.get("/healthz")).ok();
    } catch {
      return false;
    }
  }, "server starts");
  for (const [engine, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    clearLimits();
    browser = await type.launch();
    const contexts = await Promise.all(
      [1, 2, 3].map(() =>
        browser.newContext({
          ignoreHTTPSErrors: true,
          viewport: { width: 390, height: 844 },
        }),
      ),
    );
    const [requester, mailbox, resetter] = contexts;
    const [page, completion, recovery] = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const errors = [];
    for (const current of [page, completion, recovery]) {
      current.setDefaultTimeout(15000);
      current.on("pageerror", (error) => errors.push(error.message));
      current.on("console", (message) => {
        if (/pattern|SyntaxError|unhandled/i.test(message.text()))
          errors.push(message.text());
      });
    }
    const email = `teacher-${engine}@example.test`;
    await page.goto(origin + "/teacher");
    await requestEmail(page, "Sign up", email);
    assert.equal(
      (await requester.request.get(origin + "/api/auth/session")).status(),
      401,
    );
    await completion.goto(mailLink(email));
    await completion
      .getByRole("heading", { name: "Choose your password", exact: true })
      .waitFor();
    assert.equal(new URL(completion.url()).hash, "");
    assert.equal(
      (await mailbox.request.get(origin + "/api/auth/session")).status(),
      401,
    );
    await privacy(completion);
    await completion.getByLabel("New password", { exact: true }).fill(password);
    await completion
      .getByRole("button", { name: "Open workspace", exact: true })
      .click();
    await completion
      .getByRole("heading", { name: "Your classrooms", exact: true })
      .waitFor();
    assert.equal(
      await completion
        .getByText("Save your recovery kit", { exact: true })
        .count(),
      0,
    );
    await completion
      .getByLabel("Classroom name", { exact: true })
      .fill("Email classroom " + engine);
    await completion
      .getByLabel("Learner alias", { exact: true })
      .fill("Learner A");
    await completion
      .getByRole("button", { name: "Create first board", exact: true })
      .click();
    await completion
      .getByRole("heading", { name: "Learner A", exact: true })
      .waitFor();
    const rooms = await (
      await mailbox.request.get(origin + "/api/classrooms")
    ).json();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByLabel("Email or username", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("heading", { name: "Your classrooms", exact: true })
      .waitFor();
    clearLimits();
    await recovery.goto(origin + "/teacher");
    await requestEmail(recovery, "Forgot password?", email);
    await recovery.goto(mailLink(email));
    await recovery
      .getByLabel("New password", { exact: true })
      .fill(nextPassword);
    await recovery
      .getByRole("button", { name: "Open workspace", exact: true })
      .click();
    await recovery
      .getByRole("heading", { name: "Your classrooms", exact: true })
      .waitFor();
    assert.equal(
      (await mailbox.request.get(origin + "/api/auth/session")).status(),
      401,
    );
    assert.equal(
      (await requester.request.get(origin + "/api/auth/session")).status(),
      401,
    );
    assert.deepEqual(
      await (await resetter.request.get(origin + "/api/classrooms")).json(),
      rooms,
    );
    await recovery.screenshot({
      path: join(artifacts, engine + "-recovered.png"),
      fullPage: true,
    });
    await startApp({ SAYBOARD_TEACHER_ACCOUNT_MODE: "username" });
    clearLimits();
    await page.goto(origin + "/teacher");
    await page.getByRole("button", { name: "Sign up", exact: true }).click();
    const username = page.getByLabel("Teacher username", { exact: true });
    for (const [name, valid] of [
      ["legacy-name_1", true],
      ["bad@name", false],
    ]) {
      await username.fill(name);
      assert.equal(
        await username.evaluate((node) => node.checkValidity()),
        valid,
      );
    }
    await username.fill("legacy_" + engine);
    await page.getByLabel("New password", { exact: true }).fill(password);
    await page
      .getByRole("button", { name: "Create workspace", exact: true })
      .click();
    await page
      .getByRole("button", { name: "I saved my recovery kit", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Your classrooms", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page
      .getByLabel("Email or username", { exact: true })
      .fill("legacy_" + engine);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("heading", { name: "Your classrooms", exact: true })
      .waitFor();
    clearLimits();
    const linked = `linked-${engine}@example.test`;
    await requestEmail(page, "Add recovery email", linked);
    await page.goto(mailLink(linked));
    await page
      .getByRole("heading", { name: "Confirm recovery email", exact: true })
      .waitFor();
    await page
      .getByText(
        `Add ${linked} to teacher account legacy_${engine}. Confirm only if this is your account.`,
        { exact: true },
      )
      .waitFor();
    await page.getByLabel("Current password", { exact: true }).fill(password);
    await page
      .getByRole("button", { name: "Confirm email", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Your classrooms", exact: true })
      .waitFor();
    await page
      .getByText(`Recovery email: ${linked}`, { exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      true,
      "Linked account settings fit a narrow screen",
    );
    await page.screenshot({
      path: join(artifacts, engine + "-linked.png"),
      fullPage: true,
    });
    for (const current of [page, completion, recovery]) await privacy(current);
    assert.deepEqual(errors, []);
    report.engines.push({
      engine,
      crossContextSignup: true,
      emailSignin: true,
      firstBoard: true,
      resetRevokesSessions: true,
      classroomPreserved: true,
      legacySigninAndLink: true,
      usernamePattern: true,
      privacy: true,
      consoleErrors: 0,
    });
    await browser.close();
    browser = null;
    await startApp({ SAYBOARD_TEACHER_ACCOUNT_MODE: "verified-email" });
  }
  await startApp({ SAYBOARD_SIGNUP_ENABLED: "0" });
  assert.equal(
    (await (await client.get("/api/auth/capabilities")).json()).signupEnabled,
    false,
  );
  assert.equal(
    (
      await client.post("/api/auth/email/request", {
        headers: { Origin: origin },
        data: { kind: "signup", email: "closed@example.test" },
      })
    ).status(),
    403,
  );
  await startApp({ SAYBOARD_SMTP_HOST: "" });
  const capabilities = await (
    await client.get("/api/auth/capabilities")
  ).json();
  assert.equal(capabilities.signupEnabled, false);
  assert.equal(capabilities.emailAvailability, "unavailable");
  assert.equal(
    (
      await client.post("/api/auth/register", {
        headers: { Origin: origin },
        data: { username: "bypass", password },
      })
    ).status(),
    403,
  );
  assert.equal(
    (
      await client.post("/api/auth/login", {
        headers: { Origin: origin },
        data: {
          username: "teacher-webkit@example.test",
          password: nextPassword,
        },
      })
    ).status(),
    200,
  );
  assert.equal(
    [...secrets].some((secret) => serverLog.includes(secret)),
    false,
  );
  assert.equal(
    smtp.messages.some((message) => serverLog.includes(message.recipient)),
    false,
  );
  await writeFile(
    join(artifacts, "report.json"),
    JSON.stringify(
      { ...report, closedAndUnconfigured: true, passed: true },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, artifacts, report }));
} catch (error) {
  let message = error instanceof Error ? error.stack : String(error);
  for (const secret of secrets)
    message = message.replaceAll(secret, "[redacted]");
  await writeFile(
    join(artifacts, "report.json"),
    JSON.stringify({ ...report, passed: false, failure: message }, null, 2),
  );
  throw new Error(message);
} finally {
  await browser?.close();
  await client.dispose();
  await stopApp();
  await smtp.close();
  proxy.closeAllConnections();
  await new Promise((done) => proxy.close(done));
  await rm(temporary, { recursive: true, force: true });
}
