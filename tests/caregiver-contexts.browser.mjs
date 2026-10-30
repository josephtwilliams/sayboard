import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = (
  process.env.SAYBOARD_PREVIEW_URL || "http://127.0.0.1:5189"
).replace(/\/$/, "");
const board = {
  version: 2,
  voice: "",
  rate: 0.85,
  size: "standard",
  tiles: [
    {
      kind: "word",
      id: "yes",
      label: "Yes",
      phrase: "Yes",
      icon: "check",
      tone: "mint",
    },
    null,
  ],
  subBoards: [],
};
const layout = { columns: 2, size: null };
const roomId = "11111111-1111-1111-1111-111111111111";
const profileId = "22222222-2222-2222-2222-222222222222";
const click = (page, name) =>
  page.getByRole("button", { name, exact: true }).click();
async function openEditor(page) {
  await click(page, "Caregiver controls");
  await click(page, "Edit board and settings");
}
async function rename(page, before, after) {
  await click(page, `Edit ${before}`);
  await page.getByLabel("Text on the tile", { exact: true }).fill(after);
  await page.getByLabel("Text to speak", { exact: true }).fill(after);
  await click(page, "Apply changes");
}
async function localState(page) {
  return page.evaluate(() => ({
    board: JSON.parse(localStorage.getItem("sayboard-v2")),
    layout: JSON.parse(localStorage.getItem("sayboard-device-layout-v1")),
  }));
}
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
});
const results = [];
try {
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    for (const scenario of ["example", "profile", "classroom-setup"]) {
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        let failSave = false;
        let profile = {
          id: profileId,
          label: "Example learner",
          revision: 1,
          publishedVersion: 0,
          versions: [],
          devices: [],
          board: {
            ...structuredClone(board),
            tiles: [
              {
                ...board.tiles[0],
                label: "Teacher word",
                phrase: "Teacher word",
              },
              null,
            ],
          },
        };
        await page.route("**/api/auth/capabilities", (route) =>
          route.fulfill({
            json: { state: scenario === "profile" ? "enabled" : "disabled" },
          }),
        );
        await page.route("**/api/auth/session", (route) =>
          route.fulfill({
            json: {
              account: { username: "fixture" },
              csrfToken: "fixture-token",
              expiresAt: 2_000_000_000_000,
            },
          }),
        );
        await page.route(`**/api/profiles/${profileId}`, async (route) => {
          if (route.request().method() === "PUT") {
            if (failSave)
              return route.fulfill({
                status: 503,
                json: { error: "fixture_failure" },
              });
            const next = route.request().postDataJSON();
            assert.equal(next.revision, profile.revision);
            profile = {
              ...profile,
              board: next.board,
              revision: profile.revision + 1,
            };
          } else assert.equal(route.request().method(), "GET");
          return route.fulfill({ json: profile });
        });
        await page.route(`**/api/classrooms/${roomId}`, (route) =>
          route.fulfill({
            json: {
              id: roomId,
              name: "Fixture classroom",
              profiles: [profile],
            },
          }),
        );
        await page.addInitScript(
          ({ board, layout }) => {
            localStorage.setItem("sayboard-v2", JSON.stringify(board));
            localStorage.setItem(
              "sayboard-device-layout-v1",
              JSON.stringify(layout),
            );
            sessionStorage.setItem(
              "sayboard-teacher-demo-v1",
              JSON.stringify(board),
            );
            window.__failDemoIntent = false;
            const setItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function (key, value) {
              if (
                key === "sayboard-teacher-demo-pending" &&
                window.__failDemoIntent
              )
                throw new DOMException(
                  "Fixture tab quota",
                  "QuotaExceededError",
                );
              return setItem.call(this, key, value);
            };
            speechSynthesis.getVoices = () => [];
          },
          { board, layout },
        );

        if (scenario === "example") {
          await page.goto(origin + "/?teacherDemo=1");
          await openEditor(page);
          await page
            .getByText("Display and tile size", { exact: true })
            .click();
          await page
            .getByLabel(/Board columns on this device/)
            .selectOption("3");
          await rename(page, "Yes", "Demo word");
          await click(page, "Save board");
          await page
            .getByRole("button", { name: "Say Demo word", exact: true })
            .waitFor();
          assert.deepEqual(await localState(page), { board, layout });
          assert.equal(
            await page
              .locator(".grid")
              .evaluate((node) =>
                node.style.getPropertyValue("--board-columns"),
              ),
            "2",
          );
          await openEditor(page);
          await rename(page, "Demo word", "Pending demo");
          await page.evaluate(() => {
            window.__failDemoIntent = true;
          });
          await click(page, "Save changes and continue to teacher workspace");
          await page
            .locator("#status")
            .filter({ hasText: "cannot keep the example for sign-in" })
            .waitFor();
          await page
            .getByRole("button", { name: "Edit Pending demo", exact: true })
            .waitFor();
          const example = await page.evaluate(() =>
            JSON.parse(sessionStorage.getItem("sayboard-teacher-demo-v1")),
          );
          assert.equal(example.tiles[0].label, "Pending demo");
          assert.equal(
            await page.locator(".editor-save-state").textContent(),
            "No unsaved changes",
          );
          results.push({
            viewport,
            scenario,
            example,
            local: await localState(page),
            editorRetained: true,
          });
        } else if (scenario === "profile") {
          await page.goto(
            origin + `/?teacherBoard=${profileId}&classroom=${roomId}`,
          );
          await page
            .getByRole("button", { name: "Edit Teacher word", exact: true })
            .waitFor();
          await page
            .getByText("Voice and speaking speed", { exact: true })
            .click();
          await rename(page, "Teacher word", "Teacher changed");
          failSave = true;
          await click(page, "Save draft");
          await page
            .locator(".teacher-board-feedback")
            .filter({ hasText: "Classroom hosting is unavailable" })
            .waitFor();
          assert.equal(profile.revision, 1);
          await page
            .getByRole("button", { name: "Edit Teacher changed", exact: true })
            .waitFor();
          failSave = false;
          await click(page, "Save draft");
          await page
            .locator(".teacher-board-feedback")
            .filter({ hasText: "Classroom draft saved" })
            .waitFor();
          assert.equal(profile.revision, 2);
          assert.equal(profile.board.tiles[0].label, "Teacher changed");
          assert.equal(
            await page
              .getByRole("button", { name: "Publish", exact: true })
              .isEnabled(),
            true,
          );
          assert.equal(
            await page
              .locator(".settings-group")
              .filter({ hasText: "Voice and speaking speed" })
              .evaluate((node) => node.open),
            true,
          );
          await click(page, "Preview board");
          await page
            .getByRole("button", { name: "Say Teacher changed", exact: true })
            .waitFor();
          await click(page, "Preview board");
          await page
            .getByRole("button", { name: "Edit Teacher changed", exact: true })
            .waitFor();
          assert.deepEqual(await localState(page), { board, layout });
          results.push({
            viewport,
            scenario,
            profile,
            local: await localState(page),
            clean: true,
          });
        } else {
          await page.goto(origin + "/?linkClassroom=1");
          await page
            .getByRole("heading", { name: "Edit board", exact: true })
            .waitFor();
          assert.equal(
            new URL(page.url()).searchParams.has("linkClassroom"),
            false,
          );
          assert.equal(
            await page
              .locator(".settings-group")
              .filter({ hasText: "Backup and transfer" })
              .evaluate((node) => node.open),
            true,
          );
          assert.equal(
            await page.locator(".editor-save-state").textContent(),
            "No unsaved changes",
          );
          assert.deepEqual(await localState(page), { board, layout });
          results.push({
            viewport,
            scenario,
            local: await localState(page),
            setupOpen: true,
          });
        }
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
