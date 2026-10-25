import { checkDirectBoard } from "./direct-board.browser.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { checkTeacherExampleSave } from "./teacher-example-save.browser.mjs";

// Uses the actual app, authentication cookies, API and SQLite store. The caller
// provides synthetic credentials from an isolated test installation.
export async function checkClassroomFlow({
  browser,
  origin,
  username,
  password,
  engine,
  artifactDirectory,
}) {
  const teacher = await browser.newContext({
    ignoreHTTPSErrors: new URL(origin).hostname === "localhost",
    viewport:
      engine === "webkit"
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
  });
  const device = await browser.newContext({
    ignoreHTTPSErrors: new URL(origin).hostname === "localhost",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  // Stub only the operating system's speech boundary, with an explicit held
  // utterance so the test can prove a board is not rearranged during speech.
  await device.addInitScript(() => {
    window.__holdClassroomSpeech = false;
    window.__classroomUtterance = null;
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      value: class {
        constructor(text) {
          this.text = text;
        }
      },
    });
    Object.defineProperty(window, "speechSynthesis", {
      value: {
        getVoices: () => [
          {
            name: "Synthetic local voice",
            voiceURI: "synthetic-local",
            localService: true,
            lang: "en-AU",
          },
        ],
        addEventListener: () => {},
        speak: (utterance) => {
          utterance.onstart?.();
          if (window.__holdClassroomSpeech)
            window.__classroomUtterance = utterance;
          else utterance.onend?.();
        },
        cancel: () => {
          window.__classroomUtterance = null;
        },
      },
    });
  });
  const errors = [];
  const reloadTransportErrors = [];
  const diagnostics = { requestFailures: [], pageErrors: [], reloads: [] };
  const requestStarts = new WeakMap();
  let deviceOffline = false;
  let deviceReloading = false;
  const setDeviceOffline = async (offline) => {
    deviceOffline = offline;
    await device.setOffline(offline);
  };
  const page = await teacher.newPage();
  const tablet = await device.newPage();
  const reloadDevice = async (label) => {
    const reload = { startedAt: Date.now(), label, finishedAt: null };
    diagnostics.reloads.push(reload);
    deviceReloading = true;
    try {
      await tablet.reload();
      await tablet
        .getByRole("button", { name: "Say " + label, exact: true })
        .waitFor();
    } finally {
      reload.finishedAt = Date.now();
      deviceReloading = false;
    }
  };
  for (const current of [page, tablet]) {
    current.setDefaultTimeout(15000);
    current.on("request", (request) => {
      requestStarts.set(request, {
        at: Date.now(),
        offline: current === tablet && deviceOffline,
      });
    });
    current.on("requestfailed", (request) => {
      diagnostics.requestFailures.push({
        at: Date.now(),
        page: current.url(),
        url: request.url(),
        failure: request.failure()?.errorText,
        start: requestStarts.get(request),
        offline: current === tablet && deviceOffline,
      });
    });
    current.on("pageerror", (error) => {
      diagnostics.pageErrors.push({
        at: Date.now(),
        page: current.url(),
        message: error.message,
        stack: error.stack,
        device: current === tablet,
        offline: deviceOffline,
        reloading: deviceReloading,
      });
      // WebKit can report a caught fetch from the retiring document as a page
      // error during reload. Accept only that exact same-origin sync transport
      // message inside a reload explicitly initiated by this fixture.
      if (
        current === tablet &&
        deviceReloading &&
        engine === "webkit" &&
        error.message ===
          `/${new URL(origin).host}/api/device/sync due to access control checks.` &&
        error.stack?.startsWith(
          `Fetch API cannot load ${origin}/api/device/sync due to access control checks.`,
        )
      ) {
        reloadTransportErrors.push(error.message);
        return;
      }
      errors.push(error.message);
    });
  }
  const confirm = (current) =>
    current.getByRole("button", { name: "Confirm", exact: true }).click();
  const editDevice = async () => {
    await tablet
      .getByRole("button", { name: "Caregiver controls", exact: true })
      .click();
    await tablet
      .getByRole("button", { name: "Edit board and settings", exact: true })
      .click();
    await tablet
      .locator("summary")
      .filter({ hasText: "Backup and transfer" })
      .click();
  };
  try {
    const marker = {
      version: 2,
      size: "standard",
      voice: "",
      rate: 1,
      subBoards: [],
      tiles: [
        {
          kind: "word",
          id: "teacher-local-marker",
          label: "Keep my local board",
          phrase: "Keep my local board",
          icon: "heart",
          tone: "mint",
        },
      ],
    };
    await page.goto(origin + "/teacher");
    await page.evaluate(
      (value) => localStorage.setItem("sayboard-v2", JSON.stringify(value)),
      marker,
    );
    await page
      .getByRole("button", { name: "Sign in", exact: true })
      .waitFor({ state: "visible" });
    await page
      .getByText("Sign in to open your classrooms.", { exact: true })
      .waitFor();
    if (artifactDirectory) {
      await mkdir(artifactDirectory, { recursive: true });
      await page.screenshot({
        path: artifactDirectory + `/teacher-entry-${engine}.png`,
        fullPage: true,
      });
    }
    await page.getByRole("link", { name: "Try a board", exact: true }).click();
    await page.getByRole("button", { name: "Say Yes", exact: true }).waitFor();
    const demoRequests = [];
    const recordDemo = (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/"))
        demoRequests.push(request.url());
    };
    page.on("request", recordDemo);
    await page
      .getByRole("button", { name: "Caregiver controls", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit board and settings", exact: true })
      .click();
    await page.getByRole("button", { name: "Edit Yes", exact: true }).click();
    await page
      .getByLabel("Text on the tile", { exact: true })
      .fill("Example hello");
    await page
      .getByLabel("Text to speak", { exact: true })
      .fill("Example hello");
    await page
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await page.getByRole("button", { name: "Save board", exact: true }).click();
    await page.reload();
    await page
      .getByRole("button", { name: "Say Example hello", exact: true })
      .waitFor();
    assert.deepEqual(
      await page.evaluate(() =>
        JSON.parse(localStorage.getItem("sayboard-v2")),
      ),
      marker,
    );
    assert.deepEqual(
      demoRequests,
      [],
      "The anonymous example must not request account or classroom data",
    );
    page.off("request", recordDemo);
    await page
      .getByRole("link", { name: "Back to teacher welcome", exact: true })
      .click();
    await page.getByRole("link", { name: "Try a board", exact: true }).click();
    await page
      .getByRole("button", { name: "Say Example hello", exact: true })
      .waitFor();
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
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Export board", exact: true })
      .click();
    const exported = JSON.parse(
      await (await download).createReadStream().then(async (stream) => {
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return Buffer.concat(chunks).toString("utf8");
      }),
    );
    assert.ok(
      exported.tiles.some((tile) => tile?.label === "Example hello"),
      "The example can be exported before signup",
    );
    await page
      .getByRole("button", { name: "Back to board", exact: true })
      .click();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "Example fits the viewport",
    );
    await page
      .getByRole("button", { name: "Save to teacher workspace", exact: true })
      .click();
    // Google returns to a fixed /teacher URL too. Intent and edits must survive
    // that redirect without being placed in a URL or uploaded before consent.
    await page.goto(origin + "/teacher");
    await page.getByLabel("Teacher username", { exact: true }).fill(username);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("heading", { name: "Your classrooms", exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "First-board setup fits the viewport",
    );
    if (artifactDirectory)
      await page.screenshot({
        path: artifactDirectory + `/teacher-first-board-${engine}.png`,
        fullPage: true,
      });
    const classroomName = "Demonstration " + engine;
    await page
      .getByLabel("Classroom name", { exact: true })
      .fill(classroomName);
    await page
      .getByLabel("Learner alias", { exact: true })
      .fill("Demo learner");
    const failedCreation = /\/api\/classrooms\/[^/]+\/profiles$/;
    await page.route(failedCreation, (route) => route.abort("failed"), {
      times: 1,
    });
    await page
      .getByRole("button", { name: "Create first board", exact: true })
      .click();
    await page
      .getByText(
        "The classroom service could not be reached. Your device board is unchanged. Try again when connected.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await page.getByLabel("Profile alias", { exact: true }).inputValue(),
      "Demo learner",
    );
    const partial = await (
      await teacher.request.get(origin + "/api/classrooms")
    ).json();
    assert.equal(
      partial.classrooms.length,
      1,
      "An interrupted first setup keeps one recoverable classroom",
    );
    assert.equal(
      await page
        .locator(".teacher-status")
        .evaluate((node) => document.activeElement === node),
      true,
    );
    await page
      .getByRole("button", { name: "Add profile", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Demo learner", exact: true })
      .waitFor();
    const ids = new URL(page.url()).hash.slice(1).split("/");
    assert.equal(ids.length, 2);
    assert.equal(
      await page.evaluate(() =>
        sessionStorage.getItem("sayboard-teacher-demo-pending"),
      ),
      null,
    );
    await checkDirectBoard({
      page,
      context: teacher,
      origin,
      profileId: ids[1],
      engine,
      artifactDirectory,
    });
    // These destinations must remain real browser-history entries.
    const workspaceLinks = await page
      .getByRole("navigation", { name: "Learner workspace", exact: true })
      .getByRole("link")
      .allTextContents();
    assert.deepEqual(workspaceLinks, ["Board", "Devices", "Versions"]);
    const learnerURL = page.url();
    await page
      .getByRole("navigation", { name: "Location", exact: true })
      .getByRole("link", { name: classroomName, exact: true })
      .click();
    await page
      .getByRole("heading", { name: classroomName, exact: true })
      .waitFor();
    await page.goBack();
    await page
      .getByRole("heading", { name: "Demo learner", exact: true })
      .waitFor();
    assert.equal(page.url(), learnerURL);
    await page.goForward();
    await page
      .getByRole("heading", { name: classroomName, exact: true })
      .waitFor();
    await page.goBack();
    await page
      .getByRole("heading", { name: "Demo learner", exact: true })
      .waitFor();
    await page.getByRole("link", { name: "Devices", exact: true }).click();
    await page
      .getByRole("heading", { name: "Connected devices", exact: true })
      .waitFor();
    assert.ok(new URL(page.url()).hash.endsWith("/devices"));
    await page.reload();
    await page
      .getByRole("heading", { name: "Connected devices", exact: true })
      .waitFor();
    await page.goBack();
    await page
      .getByRole("link", { name: "Board settings", exact: true })
      .waitFor();
    const changeDraft = async (previous, next) => {
      await page
        .getByRole("link", { name: "Board settings", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Demo learner", exact: true })
        .waitFor();
      if (previous === "Example hello") {
        await page
          .getByRole("navigation", { name: "Teacher navigation", exact: true })
          .getByRole("button", { name: "Sign out", exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "Open Drink category", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Edit Water", exact: true })
          .waitFor();
        await page
          .getByRole("button", { name: "Home board", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Edit " + previous, exact: true })
          .waitFor();
      }
      await page
        .getByRole("button", { name: "Edit " + previous, exact: true })
        .click();
      await page.getByLabel("Text on the tile", { exact: true }).fill(next);
      await page.getByLabel("Text to speak", { exact: true }).fill(next);
      await page
        .getByRole("button", { name: "Apply changes", exact: true })
        .click();
      if (previous === "Example hello") {
        await page
          .getByRole("button", { name: "Done editing", exact: true })
          .click();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await page
          .getByRole("button", { name: "Edit " + next, exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "Publish", exact: true })
            .isDisabled(),
          true,
        );
      }
      if (previous === "Example hello") {
        const saveURL = "**/api/profiles/" + ids[1];
        await teacher.route(saveURL, (route) =>
          route.request().method() === "PUT"
            ? route.fulfill({
                status: 503,
                json: { error: "storage_unavailable" },
              })
            : route.continue(),
        );
        await page
          .getByRole("button", { name: "Save draft", exact: true })
          .click();
        await page.locator(".teacher-board-feedback.error").waitFor();
        await page
          .getByRole("button", { name: "Edit " + next, exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "Publish", exact: true })
            .isDisabled(),
          true,
        );
        await teacher.unroute(saveURL);
      }
      const editingURL = page.url();
      await page
        .getByRole("button", { name: "Save draft", exact: true })
        .click();
      await page
        .locator(".teacher-board-feedback")
        .filter({ hasText: "Classroom draft saved" })
        .waitFor();
      assert.equal(
        page.url(),
        editingURL,
        "Save must keep the current editor address",
      );
      assert.ok(
        new URL(page.url()).searchParams.has("teacherBoard"),
        "Saving keeps the editor open",
      );
      if (previous === "Example hello") {
        const originalViewport = page.viewportSize();
        for (const width of [320, 390, 768, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            true,
            "Teacher editor fits " + width + "px",
          );
        }
        await page.setViewportSize(originalViewport);
        if (artifactDirectory)
          await page.screenshot({
            path: artifactDirectory + `/teacher-editor-${engine}.png`,
            fullPage: false,
          });
      }
      await page
        .getByRole("button", { name: "Done editing", exact: true })
        .click();
      await page.waitForURL(/\/teacher#/);
      await page
        .getByRole("heading", { name: "Demo learner", exact: true })
        .waitFor();
      assert.deepEqual(
        await page.evaluate(() =>
          JSON.parse(localStorage.getItem("sayboard-v2")),
        ),
        marker,
        "Teacher editing must not replace the local communication board",
      );
    };
    await changeDraft("Example hello", "Published one");
    await page
      .getByRole("link", { name: "Preview board", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Say Published one", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Caregiver controls", exact: true })
        .count(),
      0,
    );
    await page
      .getByRole("button", { name: "Open Drink category", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Say Water", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Home board", exact: true }).click();
    await page
      .getByRole("button", { name: "Say Published one", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Home board", exact: true })
        .isDisabled(),
      true,
    );
    await page
      .getByRole("button", { name: "Open Drink category", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Say Water", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Done editing", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Demo learner", exact: true })
      .waitFor();
    const publish = async () => {
      await page.getByRole("button", { name: "Publish", exact: true }).click();
      await confirm(page);
    };
    const toolbarBeforePublish = await page
      .getByRole("button", { name: "Publish", exact: true })
      .boundingBox();
    const publishedURL = page.url();
    await publish();
    // Wait for publication and its workspace rerender before measuring the toolbar.
    await page
      .getByRole("heading", { name: "Published version 1", exact: true })
      .waitFor();
    assert.equal(
      page.url(),
      publishedURL,
      "Publish must keep the workspace address",
    );
    const toolbarAfterPublish = await page
      .getByRole("button", { name: "Publish", exact: true })
      .boundingBox();
    assert.ok(
      Math.abs(toolbarAfterPublish.y - toolbarBeforePublish.y) <= 2,
      "Publishing must not jump to device setup",
    );
    assert.deepEqual(
      await page
        .getByRole("navigation", { name: "Learner workspace", exact: true })
        .getByRole("link")
        .allTextContents(),
      workspaceLinks,
    );
    if (artifactDirectory) {
      await mkdir(artifactDirectory, { recursive: true });
      await page.screenshot({
        path: artifactDirectory + `/teacher-${engine}.png`,
        fullPage: true,
      });
    }
    await page.getByRole("link", { name: "Devices", exact: true }).click();
    await page
      .getByRole("heading", { name: "Connected devices", exact: true })
      .waitFor();
    await page.getByLabel("Device name", { exact: true }).fill("Demo tablet");
    await page
      .getByRole("button", { name: "Create pairing code", exact: true })
      .click();
    const pairing = await page.locator(".teacher-pairing code").innerText();
    assert.match(pairing, /^[A-F0-9]{10}$/);
    const unlinkedRequests = [];
    const recordUnlinked = (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/device/"))
        unlinkedRequests.push(request.url());
    };
    device.on("request", recordUnlinked);
    await tablet.goto(origin);
    await new Promise((resolve) => setTimeout(resolve, 6500));
    device.off("request", recordUnlinked);
    assert.deepEqual(
      unlinkedRequests,
      [],
      "An unlinked free board must not poll classroom services",
    );
    const learnerAddress = await page
      .getByLabel("Open this address on the learner’s device", { exact: true })
      .inputValue();
    assert.equal(new URL(learnerAddress).search, "?linkClassroom=1");
    await tablet.goto(learnerAddress);
    await tablet
      .getByLabel("Classroom pairing code", { exact: true })
      .waitFor();
    assert.equal(
      await tablet
        .getByLabel("Classroom pairing code", { exact: true })
        .evaluate((node) => document.activeElement === node),
      true,
    );
    const beforePairing = await tablet.evaluate(() =>
      localStorage.getItem("sayboard-v2"),
    );
    await tablet
      .getByLabel("Classroom pairing code", { exact: true })
      .fill(pairing);
    await tablet
      .getByRole("button", { name: "Link classroom device", exact: true })
      .click();
    await confirm(tablet);
    await tablet
      .getByRole("button", { name: "Disconnect classroom device", exact: true })
      .waitFor();
    // Keyboard and switch users must keep their place across background polls.
    const disconnect = await tablet
      .getByRole("button", { name: "Disconnect classroom device", exact: true })
      .elementHandle();
    await disconnect.focus();
    await new Promise((resolve) => setTimeout(resolve, 6500));
    assert.equal(
      await disconnect.evaluate((node) => document.activeElement === node),
      true,
      "Unchanged classroom polls must not replace the focused control",
    );
    assert.equal(
      await tablet.evaluate(() => localStorage.getItem("sayboard-v2")),
      beforePairing,
      "Pairing must wait for the caregiver to return to the communication board",
    );
    await tablet
      .getByRole("button", { name: "Back to board", exact: true })
      .click();
    const session = await (
      await teacher.request.get(origin + "/api/auth/session")
    ).json();
    const profilePath = origin + "/api/profiles/" + ids[1];
    const headers = { Origin: origin, "X-CSRF-Token": session.csrfToken };
    let expectedVersion = 1;
    const profile = async () => {
      const response = await teacher.request.get(profilePath);
      assert.equal(response.status(), 200);
      return response.json();
    };
    const persisted = () =>
      tablet.evaluate(() => JSON.parse(localStorage.getItem("sayboard-v2")));
    const hasLabel = (board, label) =>
      [board, ...(board?.subBoards ?? [])].some((page) =>
        page?.tiles.some((tile) => tile?.label === label),
      );
    const waitUntil = async (check, message, timeout = 20000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.fail(message);
    };
    const latencies = [];
    const applied = async (label, since = Date.now()) => {
      await tablet
        .getByRole("button", { name: "Say " + label, exact: true })
        .waitFor({ timeout: 20000 });
      assert.ok(
        hasLabel(await persisted(), label),
        "Rendered publication must already be saved durably",
      );
      await waitUntil(async () => {
        const row = (await profile()).devices.find(
          (value) => value.name === "Demo tablet",
        );
        return (
          row?.appliedVersion === expectedVersion &&
          row.appliedAt > 0 &&
          row.lastSeenAt > 0
        );
      }, "Teacher must receive the version that the device actually saved");
      latencies.push(Date.now() - since);
    };
    const publishLabel = async (label, edit = () => {}) => {
      let current = await profile();
      const next = structuredClone(current.board);
      const tile = next.tiles.find((value) => value?.kind === "word");
      tile.label = label;
      tile.phrase = label;
      edit(next);
      const saved = await teacher.request.put(profilePath, {
        headers,
        data: { board: next, revision: current.revision },
      });
      assert.equal(saved.status(), 200);
      current = await saved.json();
      const response = await teacher.request.post(profilePath + "/publish", {
        headers,
        data: { revision: current.revision },
      });
      assert.equal(response.status(), 200);
      expectedVersion = (await response.json()).publishedVersion;
      return Date.now();
    };
    const stays = async (label) => {
      // More than two real foreground poll periods, with no production clocks mocked.
      await new Promise((resolve) => setTimeout(resolve, 6500));
      assert.ok(
        hasLabel(await persisted(), label),
        "Active communication or a caregiver draft must retain its current board",
      );
      const row = (await profile()).devices.find(
        (value) => value.name === "Demo tablet",
      );
      assert.notEqual(
        row.appliedVersion,
        expectedVersion,
        "A waiting update must not be reported as applied",
      );
    };

    await applied("Published one");
    await reloadDevice("Published one");
    assert.equal(
      (await device.request.get(origin + "/api/classrooms")).status(),
      401,
    );

    // This is the classroom acceptance test. Only the teacher acts after pairing.
    // There are no learner clicks, reloads, or explicit API calls to make it sync.
    await changeDraft("Published one", "Published two");
    const untouchedAt = Date.now();
    await publish();
    expectedVersion = 2;
    await page
      .getByRole("heading", { name: "Published version 2", exact: true })
      .waitFor();
    await applied("Published two", untouchedAt);
    await page.getByRole("link", { name: "Devices", exact: true }).click();
    await page
      .locator(".teacher-device-row")
      .filter({ hasText: "Demo tablet" })
      .getByText("Version 2 saved. Up to date", { exact: true })
      .waitFor({ timeout: 15000 });
    if (artifactDirectory) {
      await page.screenshot({
        path: artifactDirectory + `/teacher-automatic-${engine}.png`,
        fullPage: true,
      });
    }
    await reloadDevice("Published two");

    await page.getByRole("link", { name: "Versions", exact: true }).click();
    await page
      .getByRole("button", { name: "Restore version 1 to draft", exact: true })
      .click();
    await confirm(page);
    assert.ok(
      hasLabel(await persisted(), "Published two"),
      "Restoring a draft must not publish it",
    );
    await publish();
    expectedVersion = 3;
    await applied("Published one");

    // Slow network response A must not strand the learner on A when B is newer.
    let downloadReady = false;
    const releaseDownload = Promise.withResolvers();
    let held = false;
    await device.route("**/api/device/board", async (route) => {
      if (held) return route.continue();
      held = true;
      const response = await route.fetch();
      downloadReady = true;
      await releaseDownload.promise;
      await route.fulfill({ response });
    });
    let newestAt;
    try {
      await publishLabel("Superseded slow version");
      await waitUntil(
        () => downloadReady,
        "A new publication must trigger a board download without a learner action",
      );
      newestAt = await publishLabel("Newest version wins");
    } finally {
      releaseDownload.resolve();
    }
    await applied("Newest version wins", newestAt);
    await device.unroute("**/api/device/board");

    await setDeviceOffline(true);
    const offlineBoard = await persisted();
    await publishLabel("Published while offline");
    await new Promise((resolve) => setTimeout(resolve, 6500));
    assert.deepEqual(
      await persisted(),
      offlineBoard,
      "Network loss must preserve the last saved communication board",
    );
    await setDeviceOffline(false);
    await applied("Published while offline");

    // Simulate a browser quota failure at the real localStorage boundary. The
    // network and publication are real, and the last working board must win.
    await tablet.evaluate(() => {
      const original = Storage.prototype.setItem;
      window.__denyClassroomSave = true;
      Storage.prototype.setItem = function (key, value) {
        if (
          this === localStorage &&
          key === "sayboard-v2" &&
          window.__denyClassroomSave
        )
          throw new DOMException(
            "Synthetic quota failure",
            "QuotaExceededError",
          );
        return original.call(this, key, value);
      };
    });
    await publishLabel("Saved after storage recovers");
    await stays("Published while offline");
    await tablet
      .getByRole("button", { name: "Say Published while offline", exact: true })
      .waitFor();
    await tablet.evaluate(() => {
      window.__denyClassroomSave = false;
    });
    await applied("Saved after storage recovers");

    await tablet
      .getByLabel("Type something to say", { exact: true })
      .fill("Please keep my message");
    await publishLabel("After typed message");
    await stays("Saved after storage recovers");
    assert.equal(
      await tablet
        .getByLabel("Type something to say", { exact: true })
        .inputValue(),
      "Please keep my message",
    );
    await tablet.getByLabel("Type something to say", { exact: true }).fill("");
    assert.equal(
      await tablet
        .getByLabel("Type something to say", { exact: true })
        .evaluate((input) => document.activeElement === input),
      true,
    );
    await applied("After typed message");

    // A learner may leave an empty message field focused indefinitely. Focus
    // alone must never turn automatic publication into another manual workflow.
    await tablet.getByLabel("Type something to say", { exact: true }).focus();
    const focusedAt = await publishLabel("Empty focused input updates");
    await applied("Empty focused input updates", focusedAt);
    assert.equal(
      await tablet
        .getByLabel("Type something to say", { exact: true })
        .inputValue(),
      "",
    );

    await tablet.evaluate(() => {
      window.__holdClassroomSpeech = true;
    });
    await tablet
      .getByRole("button", {
        name: "Say Empty focused input updates",
        exact: true,
      })
      .click();
    await waitUntil(
      () => tablet.evaluate(() => Boolean(window.__classroomUtterance)),
      "Synthetic local speech must have started",
    );
    await publishLabel("After speech finishes");
    await stays("Empty focused input updates");
    await tablet.evaluate(() => {
      window.__holdClassroomSpeech = false;
      window.__classroomUtterance.onend?.();
      window.__classroomUtterance = null;
    });
    await applied("After speech finishes");

    await editDevice();
    // A failed disconnect must be announced, not replaced by the sync status.
    const classroomPanel = tablet.locator(".account-panel").filter({
      has: tablet.getByRole("heading", {
        name: "Classroom board",
        exact: true,
      }),
    });
    await device.route("**/api/device/unlink", (route) =>
      route.fulfill({ status: 503, json: { error: "storage_unavailable" } }),
    );
    await classroomPanel
      .getByRole("button", { name: "Disconnect classroom device", exact: true })
      .click();
    await confirm(tablet);
    await classroomPanel
      .getByRole("status")
      .filter({ hasText: "Classroom hosting is unavailable on this server." })
      .waitFor();
    await device.unroute("**/api/device/unlink");
    await tablet
      .getByRole("button", { name: "Edit After speech finishes", exact: true })
      .click();
    await tablet
      .getByLabel("Text on the tile", { exact: true })
      .fill("Caregiver unsaved words");
    await tablet
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await publishLabel("After caregiver draft");
    await stays("After speech finishes");
    await tablet
      .getByRole("button", {
        name: "Edit Caregiver unsaved words",
        exact: true,
      })
      .waitFor();
    await tablet
      .getByRole("button", { name: "Back to board", exact: true })
      .click();
    await confirm(tablet);
    await applied("After caregiver draft");

    await tablet
      .getByRole("button", { name: "Open Drink category", exact: true })
      .click();
    await publishLabel("Home version while category open", (next) => {
      const drink = next.tiles.find(
        (tile) => tile?.kind === "category" && tile.label === "Drink",
      );
      const water = next.subBoards
        .find((board) => board.id === drink.subBoardId)
        .tiles.find((tile) => tile?.kind === "word");
      water.label = "Water automatically updated";
      water.phrase = "Water automatically updated";
    });
    await applied("Water automatically updated");
    await tablet.getByRole("heading", { name: "Drink", exact: true }).waitFor();
    // Removing the active category must also finish without a learner action.
    await publishLabel("After category removed", (next) => {
      const drink = next.tiles.find(
        (tile) => tile?.kind === "category" && tile.label === "Drink",
      );
      next.tiles = next.tiles.map((tile) =>
        tile?.id === drink.id ? null : tile,
      );
      next.subBoards = next.subBoards.filter(
        (board) => board.id !== drink.subBoardId,
      );
    });
    await applied("After category removed");
    await tablet
      .getByRole("heading", { name: "Communication board", exact: true })
      .waitFor();
    assert.equal(
      await tablet.getByRole("heading", { name: "Drink", exact: true }).count(),
      0,
    );
    assert.equal(
      await tablet
        .getByRole("button", { name: "Back / Home", exact: true })
        .count(),
      0,
    );

    if (artifactDirectory) {
      await tablet.screenshot({
        path: artifactDirectory + `/device-automatic-${engine}.png`,
        fullPage: true,
      });
    }
    const appliedBoard = await persisted();
    const current = await profile();
    const linked = current.devices.find(
      (value) => value.name === "Demo tablet",
    );
    const revoked = await teacher.request.delete(
      profilePath + "/devices/" + linked.id,
      { headers },
    );
    assert.equal(revoked.status(), 200);
    await publishLabel("Must not reach revoked device");
    await new Promise((resolve) => setTimeout(resolve, 6500));
    assert.deepEqual(
      await persisted(),
      appliedBoard,
      "Revocation must stop new versions without deleting the working board",
    );
    await reloadDevice("After category removed");
    await setDeviceOffline(true);
    assert.ok(
      await tablet
        .getByRole("button", {
          name: "Say After category removed",
          exact: true,
        })
        .isVisible(),
    );
    assert.equal(
      (
        await teacher.request.delete(origin + "/api/classrooms/" + ids[0], {
          headers,
        })
      ).status(),
      200,
    );
    await page.goto(origin + "/teacher");
    await page
      .getByRole("heading", { name: "Your classrooms", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByLabel("Teacher username", { exact: true }).waitFor();
    assert.equal(
      (await teacher.request.get(origin + "/api/classrooms")).status(),
      401,
    );
    if (artifactDirectory) {
      await writeFile(
        artifactDirectory + `/classroom-diagnostics-${engine}.json`,
        JSON.stringify(diagnostics, null, 2) + "\n",
      );
    }
    assert.deepEqual(errors, []);
    const returningTeacher = await checkTeacherExampleSave({
      browser,
      origin,
      username,
      password,
      engine,
      artifactDirectory,
    });
    return {
      ...returningTeacher,
      engine,
      teacherLogin: true,
      anonymousDemoKeepsExistingDeviceBoard: true,
      demoBackReloadAndExportWorkBeforeSignup: true,
      demoSurvivesReloadAndFixedLoginRedirect: true,
      firstSetupRetryKeepsClassroomAliasAndExample: true,
      directPairingLinkKeepsExplicitConsent: true,
      createClassroomAndProfile: true,
      existingEditorSavesServerDraft: true,
      teacherLocalBoardUnchanged: true,
      actualBoardPreview: true,
      unlinkedFreeBoardDoesNotPollClassroom: true,
      pairOnceThenUntouchedDeviceUpdates: true,
      classroomPollsKeepFocus: true,
      publishedBoardSurvivesReload: true,
      teacherReceivesDurablyAppliedVersion: true,
      dashboardReceiptUpdatesWithoutRefresh: true,
      slowOlderDownloadCatchesLatestPublication: true,
      offlineCatchupPreservesWorkingBoard: true,
      storageFailureDoesNotApplyOrAcknowledge: true,
      temporaryStorageFailureRetriesAutomatically: true,
      typedMessageDelaysUpdate: true,
      clearingMessageUpdatesWithoutBlurring: true,
      emptyFocusedInputDoesNotBlockAutomaticUpdate: true,
      speechFinishesBeforeUpdate: true,
      failedDisconnectIsAnnounced: true,
      caregiverDraftSurvivesPublication: true,
      idleCategoryUpdatesWithoutLearnerNavigation: true,
      removedCategoryReturnsHomeAutomatically: true,
      rollbackPublishesAutomatically: true,
      deviceCannotAccessTeacherData: true,
      revocationKeepsLocalBoard: true,
      classroomDeleted: true,
      logout: true,
      automaticUpdateLatencyMs: latencies,
      expectedWebkitReloadTransportErrors: reloadTransportErrors.length,
      errors,
    };
  } catch (error) {
    if (artifactDirectory) {
      await mkdir(artifactDirectory, { recursive: true });
      await writeFile(
        artifactDirectory + `/classroom-failure-${engine}.json`,
        JSON.stringify(diagnostics, null, 2) + "\n",
      );
      await page.screenshot({
        path: artifactDirectory + `/teacher-failure-${engine}.png`,
        fullPage: true,
      });
      await tablet.screenshot({
        path: artifactDirectory + `/device-failure-${engine}.png`,
        fullPage: true,
      });
    }
    throw error;
  } finally {
    await teacher.close();
    await device.close();
  }
}
