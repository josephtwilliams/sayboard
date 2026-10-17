// Local, synthetic end-to-end check of the actual container and HTTPS proxy.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, request } from "playwright";
import { checkClassroomFlow } from "../tests/classroom-flow.browser.mjs";
import { checkTeacherRoutes } from "../tests/teacher-routes.browser.mjs";
import { checkTeacherOnboarding } from "../tests/teacher-onboarding.browser.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "sayboard-vps-check-"));
const project = `sayboard-check-${process.pid}`;
const port = Number(process.env.SAYBOARD_CHECK_PORT ?? 19443);
const origin = `https://localhost:${port}`;
const password = "Synthetic VPS review " + randomBytes(12).toString("hex");
const configuration = join(temporary, "compose.json");
const caddyfile = join(temporary, "Caddyfile");
const proxyImage = `${project}:proxy`;
const report = {};
function command(program, args, input, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: root,
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(
            new Error(
              `${program} ${args[0] ?? ""} failed (${code}): ${output.slice(-1200)}`,
            ),
          ),
    );
    child.stdin.end(input);
  });
}
const compose = (...args) =>
  command("docker", ["compose", "-p", project, "-f", configuration, ...args]);
await writeFile(
  caddyfile,
  (await readFile(join(root, "deploy/Caddyfile"), "utf8")).replace(
    "{$SAYBOARD_DOMAIN} {",
    "https://localhost {\n    tls internal",
  ),
);
// Bake the local test certificate setting into a disposable proxy image. This
// works through the Docker API even when the daemon cannot bind-mount this host.
await writeFile(
  join(temporary, "Dockerfile"),
  "FROM caddy:2\nCOPY Caddyfile /etc/caddy/Caddyfile\n",
);
const stack = JSON.parse(
  await command(
    "docker",
    [
      "compose",
      "-p",
      project,
      "-f",
      join(root, "compose.yaml"),
      ...(process.env.SAYBOARD_SMALL_VPS === "1"
        ? ["-f", join(root, "deploy/compose.small.yaml")]
        : []),
      "config",
      "--format",
      "json",
    ],
    undefined,
    {
      SAYBOARD_DOMAIN: `localhost:${port}`,
      SAYBOARD_AUTH_ENABLED: "1",
      SAYBOARD_IMAGE:
        process.env.SAYBOARD_TEST_IMAGE ?? "sayboard:publication-review",
    },
  ),
);
delete stack.services.app.build;
stack.services.app.image =
  process.env.SAYBOARD_TEST_IMAGE ?? "sayboard:publication-review";
stack.services.app.ports = [`127.0.0.1:${port}:443`];
stack.services.app.healthcheck.interval = "1s";
stack.services.proxy.image = proxyImage;
stack.services.proxy.volumes = stack.services.proxy.volumes.filter(
  (volume) => volume.type !== "bind",
);
await writeFile(configuration, JSON.stringify(stack));
let browser;
try {
  await command("docker", ["build", "-t", proxyImage, temporary]);
  await compose("up", "-d");
  const client = await request.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
  });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await client.get("/healthz")).ok()) {
        ready = true;
        break;
      }
    } catch {
      /* startup only */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(ready, "The real HTTPS stack must become healthy");
  const maintain = (args, input) =>
    command(
      "docker",
      [
        "compose",
        "-p",
        project,
        "-f",
        configuration,
        "exec",
        "-T",
        "app",
        "node",
        "server-dist/manage.cjs",
        ...args,
      ],
      input,
    );
  for (const user of ["teacher", "other_teacher"])
    await maintain(["create", user], password);
  await maintain(["enable-invites", "teacher"]);
  const signIn = async (context, username, secret = password) => {
    const response = await context.post("/api/auth/login", {
      headers: { Origin: origin },
      data: { username, password: secret },
    });
    assert.equal(response.status(), 200);
    const data = await response.json();
    return data.csrfToken;
  };
  assert.deepEqual(await (await client.get("/api/auth/capabilities")).json(), {
    state: "enabled",
  });
  assert.equal(
    (
      await client.post("/api/auth/login", {
        headers: { Origin: origin },
        data: { username: "admin", password: "admin" },
      })
    ).status(),
    401,
  );
  const csrf = await signIn(client, "teacher");
  const sessionCookie = (await client.storageState()).cookies.find(
    (cookie) => cookie.name === "__Host-sayboard_session",
  );
  assert.ok(
    sessionCookie?.secure &&
      sessionCookie.httpOnly &&
      sessionCookie.sameSite === "Strict",
  );
  const board = {
    version: 2,
    voice: "",
    rate: 1,
    size: "standard",
    tiles: [
      {
        kind: "word",
        id: "vps-fixture",
        label: "VPS demonstration",
        phrase: "VPS demonstration",
        icon: "heart",
        tone: "mint",
      },
    ],
    subBoards: [],
  };
  const write = (revision, token = csrf, source = origin) =>
    client.put("/api/board", {
      headers: { Origin: source, "X-CSRF-Token": token },
      data: { board, revision },
    });
  assert.equal((await write(0)).status(), 200);
  assert.equal((await write(0)).status(), 409);
  assert.equal((await write(1, "bad")).status(), 403);
  assert.equal(
    (await write(1, csrf, "https://attacker.example")).status(),
    403,
  );
  const second = await request.newContext({
    baseURL: origin,
    ignoreHTTPSErrors: true,
  });
  await signIn(second, "other_teacher");
  assert.deepEqual(await (await second.get("/api/board")).json(), {
    board: null,
    revision: 0,
  });
  for (const path of ["/.env", "/backend/store.ts", "/source/%2f..%2f.env"])
    assert.equal((await client.get(path)).status(), 404);
  assert.equal((await client.get("/source/")).status(), 200);
  const current = await (await client.get("/source/current.json")).json();
  assert.equal(
    (
      await client.get(`/source/${current.release}/frontend-source.tar.gz`)
    ).status(),
    200,
  );
  report.api = {
    secureLogin: true,
    noDefaultAccount: true,
    ownerIsolation: true,
    staleWriteRejected: true,
    csrfRejected: true,
    foreignOriginRejected: true,
    privatePathsRejected: true,
    sourceArchivesAvailable: true,
  };

  browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Caregiver controls", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit board and settings", exact: true })
    .click();
  await page
    .locator("summary")
    .filter({ hasText: "Backup and transfer" })
    .click();
  await page.getByLabel("Account username", { exact: true }).fill("teacher");
  await page.getByLabel("Account password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("button", { name: "Load account board", exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("button", { name: "Save board", exact: true }).click();
  await page
    .getByRole("button", { name: "Say VPS demonstration", exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByRole("button", { name: "Say VPS demonstration", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(() =>
      Object.keys(localStorage).some((key) =>
        /token|session|supabase/i.test(key),
      ),
    ),
    false,
  );
  report.browser = {
    loginAndRestoreThroughUI: true,
    localPersistenceAfterRestore: true,
    noSessionTokensInLocalStorage: true,
  };
  report.classrooms = [];
  report.onboarding = [];
  for (const [engine, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ]) {
    const classroomBrowser = await type.launch();
    try {
      await checkTeacherRoutes({ browser: classroomBrowser, origin });
      report.classrooms.push(
        await checkClassroomFlow({
          browser: classroomBrowser,
          origin,
          username: "teacher",
          password,
          engine,
          artifactDirectory: join(root, "test-results/publication/classrooms"),
        }),
      );
      // Independent fixture scenarios intentionally repeat sign-in. Reset only
      // their disposable database budgets; production limits stay unchanged.
      await compose(
        "exec",
        "-T",
        "app",
        "node",
        "-e",
        "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.env.SAYBOARD_DATABASE_PATH); db.exec('DELETE FROM login_limits'); db.close();",
      );
      const onboarding = await checkTeacherOnboarding({
        browser: classroomBrowser,
        origin,
        username: "teacher",
        password,
        engine,
        artifactDirectory: join(root, "test-results/publication/classrooms"),
      });
      report.onboarding.push(onboarding);
      await maintain([
        "delete",
        onboarding.invited,
        `--confirm-delete=${onboarding.invited}`,
      ]);
    } finally {
      await classroomBrowser.close();
    }
  }
  await compose("restart", "app");
  await compose("restart", "proxy");
  await compose("up", "-d", "--force-recreate");
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await client.get("/api/board")).ok()) break;
    } catch {
      /* restart only */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.deepEqual(
    (await (await client.get("/api/board")).json()).board,
    board,
  );
  await maintain(["backup", "/data/snapshot.sqlite"]);
  await maintain(["reset-password", "teacher"], password + " reset");
  assert.equal((await client.get("/api/board")).status(), 401);
  await signIn(client, "teacher", password + " reset");
  await compose("stop", "proxy");
  await compose("stop", "app");
  const appId = (await compose("ps", "--all", "--quiet", "app")).trim();
  await command("docker", [
    "run",
    "--rm",
    "--volumes-from",
    appId,
    "--entrypoint",
    "node",
    process.env.SAYBOARD_TEST_IMAGE ?? "sayboard:publication-review",
    "-e",
    "const fs = require('node:fs'); fs.copyFileSync('/data/snapshot.sqlite', '/data/sayboard.sqlite'); for (const suffix of ['-wal', '-shm']) fs.rmSync('/data/sayboard.sqlite' + suffix, {force:true});",
  ]);
  await compose("start", "app");
  await compose("start", "proxy");
  let restored = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await client.get("/healthz")).ok()) {
        restored = true;
        break;
      }
    } catch {
      /* restore startup only */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(restored, "The restored installation must become healthy");
  await signIn(client, "teacher");
  assert.deepEqual(
    (await (await client.get("/api/board")).json()).board,
    board,
  );
  report.persistence = {
    boardAndSessionSurviveRestart: true,
    boardAndSessionSurviveContainerRecreation: true,
    snapshotCreated: true,
    passwordResetRevokesSessions: true,
    snapshotRestoresBoardAndAccount: true,
  };
  report.freeCore = JSON.parse(
    await command(
      process.execPath,
      ["tests/free-core.browser.mjs"],
      undefined,
      { SAYBOARD_PREVIEW_URL: origin },
    ),
  );
  await mkdir(join(root, "test-results/publication"), { recursive: true });
  await writeFile(
    join(root, "test-results/publication/vps-check.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  const logs = await compose("logs", "--no-color").catch(
    () => "Unable to collect container logs",
  );
  await mkdir(join(root, "test-results/publication"), { recursive: true });
  await writeFile(
    join(root, "test-results/publication/vps-container.log"),
    logs,
  );
  await compose("down", "-v").catch(() => {});
  await command("docker", ["image", "rm", proxyImage]).catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
