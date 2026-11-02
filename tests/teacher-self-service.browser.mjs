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
const temporary = await mkdtemp(
  join(tmpdir(), "sayboard-self-service-browser-"),
);
const artifacts = join(root, "test-results/teacher-self-service");
await mkdir(artifacts, { recursive: true });
const port = Number(process.env.SAYBOARD_SELF_SERVICE_CHECK_PORT ?? 25443);
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
const app = spawn(process.execPath, ["server-dist/server.cjs"], {
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
  server: "emitted Node HTTPS server and real SQLite",
  engines: [],
};
const marker = {
  version: 2,
  size: "standard",
  voice: "",
  rate: 1,
  subBoards: [],
  tiles: [
    {
      kind: "word",
      id: "local-marker",
      label: "My device board",
      phrase: "My device board",
      icon: "heart",
      tone: "mint",
    },
  ],
};
const waitUntil = async (check, message) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 200));
  }
  assert.fail(message);
};
async function noSecrets(page) {
  const leaked = await page.evaluate(
    (values) => {
      const persisted = JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
        url: location.href,
        state: history.state,
      });
      return values.some((value) => persisted.includes(value));
    },
    [...secrets],
  );
  assert.equal(
    leaked,
    false,
    "Credential secrets must not enter browser storage or history",
  );
}
async function acknowledge(page, download = false) {
  await page
    .getByRole("heading", { name: "Save your recovery kit", exact: true })
    .waitFor();
  const code = await page
    .getByLabel("Recovery code", { exact: true })
    .inputValue();
  assert.ok(/^[a-f0-9]{64}$/.test(code));
  secrets.add(code);
  assert.equal(
    await page
      .getByRole("button", { name: "Create first board", exact: true })
      .count(),
    0,
  );
  await noSecrets(page);
  if (download) {
    const pending = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download recovery kit", exact: true })
      .click();
    const file = await pending;
    const stream = await file.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(
      Buffer.concat(chunks).toString().includes(code),
      true,
      "Downloaded kit contains the recovery code",
    );
    await file.delete();
    await page
      .getByRole("button", { name: "Copy recovery code", exact: true })
      .click();
    await page
      .getByText(/Recovery code copied\.|Copy is unavailable\./)
      .waitFor();
  }
  await page
    .getByRole("button", { name: "I saved my recovery kit", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Your classrooms", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Recovery code", { exact: true }).count(),
    0,
  );
  await noSecrets(page);
  return code;
}
try {
  await waitUntil(async () => {
    try {
      return (await client.get("/healthz")).ok();
    } catch {
      return false;
    }
  }, "Emitted server starts");
  for (const [engine, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const db = new DatabaseSync(databasePath);
    db.exec(
      "PRAGMA busy_timeout=5000; DELETE FROM login_limits; DELETE FROM self_service_limits",
    );
    db.close();
    browser = await type.launch();
    const teacher = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
    });
    const device = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
    });
    const recoveredContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await teacher.newPage();
    const tablet = await device.newPage();
    const recovery = await recoveredContext.newPage();
    const errors = [];
    for (const current of [page, tablet, recovery]) {
      current.setDefaultTimeout(15000);
      current.on("pageerror", (error) => errors.push(error.message));
    }
    const username = "self_service_" + engine;
    await page.goto(origin + "/teacher");
    await page
      .getByRole("button", { name: "Create teacher workspace", exact: true })
      .waitFor();
    await page.evaluate(
      (value) => localStorage.setItem("sayboard-v2", JSON.stringify(value)),
      marker,
    );
    await page.screenshot({
      path: join(artifacts, `${engine}-entry.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      true,
    );
    await page.getByRole("link", { name: "Try a board", exact: true }).click();
    await page.getByRole("button", { name: "Say Yes", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Caregiver controls", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit board and settings", exact: true })
      .click();
    await page.getByRole("button", { name: "Edit Yes", exact: true }).click();
    await page
      .getByLabel("Text on the tile", { exact: true })
      .fill("Self service hello");
    await page
      .getByLabel("Text to speak", { exact: true })
      .fill("Self service hello");
    await page
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await page.getByRole("button", { name: "Save board", exact: true }).click();
    await page
      .getByRole("button", { name: "Save to teacher workspace", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Create teacher workspace", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("Teacher username", { exact: true }).count(),
      1,
    );
    assert.equal(
      await page.getByRole("button", { name: "Sign in", exact: true }).count(),
      0,
    );
    await page.getByLabel("Teacher username", { exact: true }).fill(username);
    await page.getByLabel("New password", { exact: true }).fill(password);
    await page
      .getByRole("button", { name: "Create workspace", exact: true })
      .click();
    const firstCode = await acknowledge(page, true);
    assert.equal(
      (await (await teacher.request.get(origin + "/api/classrooms")).json())
        .classrooms.length,
      0,
    );
    assert.deepEqual(
      await page.evaluate(() =>
        JSON.parse(localStorage.getItem("sayboard-v2")),
      ),
      marker,
    );
    await page
      .getByLabel("Classroom name", { exact: true })
      .fill("Self service class " + engine);
    await page.getByLabel("Learner alias", { exact: true }).fill("Learner A");
    await page
      .getByRole("button", { name: "Create first board", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Learner A", exact: true })
      .waitFor();
    const ids = new URL(page.url()).hash.slice(1).split("/");
    const profilePath = origin + "/api/profiles/" + ids[1];
    const profile = await (await teacher.request.get(profilePath)).json();
    assert.equal(
      profile.board.tiles.some((tile) => tile?.label === "Self service hello"),
      true,
    );
    assert.equal(
      await page.evaluate(() =>
        sessionStorage.getItem("sayboard-teacher-demo-pending"),
      ),
      null,
    );
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await page
      .getByRole("heading", { name: "Published version 1", exact: true })
      .waitFor();
    await page.getByRole("link", { name: "Devices", exact: true }).click();
    await page
      .getByLabel("Device name", { exact: true })
      .fill("Learner tablet");
    await page
      .getByRole("button", { name: "Create pairing code", exact: true })
      .click();
    const pairing = await page.locator(".teacher-pairing code").innerText();
    await tablet.goto(origin + "/?linkClassroom=1");
    await tablet
      .getByLabel("Classroom pairing code", { exact: true })
      .fill(pairing);
    await tablet
      .getByRole("button", { name: "Link classroom device", exact: true })
      .click();
    await tablet.getByRole("button", { name: "Confirm", exact: true }).click();
    await tablet
      .getByRole("button", { name: "Disconnect classroom device", exact: true })
      .waitFor();
    await tablet
      .getByRole("button", { name: "Back to board", exact: true })
      .click();
    await tablet
      .getByRole("button", { name: "Say Self service hello", exact: true })
      .waitFor();
    await waitUntil(
      async () =>
        (await (await teacher.request.get(profilePath)).json()).devices[0]
          ?.appliedVersion === 1,
      "Learner reports durable applied version",
    );
    await page
      .getByText("Version 1 saved. Up to date", { exact: true })
      .waitFor();
    const publishedBoard = await tablet.evaluate(() =>
      localStorage.getItem("sayboard-v2"),
    );
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByLabel("Teacher username", { exact: true }).fill(username);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("heading", { name: "Your classrooms", exact: true })
      .waitFor();
    await recovery.goto(origin + "/teacher");
    await recovery
      .getByRole("button", { name: "Recover workspace", exact: true })
      .click();
    await recovery
      .getByLabel("Teacher username", { exact: true })
      .fill(username);
    await recovery.getByLabel("Recovery code", { exact: true }).fill(firstCode);
    await recovery
      .getByLabel("New password", { exact: true })
      .fill(nextPassword);
    await recovery
      .getByRole("button", { name: "Recover workspace", exact: true })
      .click();
    const secondCode = await acknowledge(recovery);
    assert.equal(secondCode === firstCode, false);
    assert.equal(
      (await teacher.request.get(origin + "/api/auth/session")).status(),
      401,
    );
    const preserved = await (
      await recoveredContext.request.get(profilePath)
    ).json();
    assert.equal(preserved.devices.length, 1);
    assert.equal(preserved.publishedVersion, 1);
    assert.equal(preserved.devices[0].appliedVersion, 1);
    assert.equal(
      await tablet.evaluate(() => localStorage.getItem("sayboard-v2")),
      publishedBoard,
    );
    assert.equal(
      await tablet
        .getByRole("button", { name: "Say Self service hello", exact: true })
        .isVisible(),
      true,
    );
    await recovery
      .getByRole("button", { name: "Recovery kit", exact: true })
      .click();
    await recovery
      .getByLabel("Current password", { exact: true })
      .fill(password);
    await recovery
      .getByRole("button", { name: "Replace recovery code", exact: true })
      .click();
    await recovery
      .getByText("Current password did not match. Try again.", { exact: true })
      .waitFor();
    assert.equal(
      (await recoveredContext.request.get(origin + "/api/auth/session")).status(),
      200,
      "A mistyped current password keeps the teacher signed in",
    );
    await recovery
      .getByLabel("Current password", { exact: true })
      .fill(nextPassword);
    await recovery
      .getByRole("button", { name: "Replace recovery code", exact: true })
      .click();
    const thirdCode = await acknowledge(recovery);
    assert.equal(thirdCode === secondCode, false);
    const replay = await client.post("/api/auth/recover", {
      headers: { Origin: origin },
      data: { username, password, recoveryCode: secondCode },
    });
    assert.equal(replay.status(), 401);
    await recovery.screenshot({
      path: join(artifacts, `${engine}-recovered-workspace.png`),
      fullPage: true,
    });
    assert.equal(
      await recovery.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      true,
    );
    await noSecrets(page);
    await noSecrets(recovery);
    assert.deepEqual(errors, []);
    report.engines.push({
      engine,
      desktopAndNarrow: true,
      demoSavedExplicitly: true,
      noInvitationOrProvider: true,
      kitDownloadAndCopy: true,
      pairedPublicationReceipt: true,
      returningSignIn: true,
      recoveryRevokesOldSession: true,
      learnerLinkPreserved: true,
      lostCodeReplacement: true,
      passwordTypoKeepsSession: true,
      noSecretPersistence: true,
      pageErrors: 0,
    });
    await browser.close();
    browser = null;
  }
  assert.equal(
    [...secrets].some((secret) => serverLog.includes(secret)),
    false,
    "Server logs exclude credential secrets",
  );
  await writeFile(
    join(artifacts, "report.json"),
    JSON.stringify({ ...report, passed: true }, null, 2),
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
  if (app.exitCode === null && app.signalCode === null)
    await new Promise((done) => {
      const watchdog = setTimeout(() => app.kill("SIGKILL"), 5000);
      watchdog.unref();
      app.once("exit", () => {
        clearTimeout(watchdog);
        done();
      });
      app.kill("SIGTERM");
    });
  proxy.closeAllConnections();
  await new Promise((done) => proxy.close(done));
  await rm(temporary, { recursive: true, force: true });
}
