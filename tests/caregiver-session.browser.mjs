import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.SAYBOARD_PREVIEW_URL || "http://127.0.0.1:5189";
const word = (id, label) => ({
  kind: "word",
  id,
  label,
  phrase: label,
  icon: "check",
  tone: "mint",
});
const fixture = {
  version: 2,
  voice: "",
  rate: 0.85,
  size: "standard",
  tiles: [
    word("yes", "Yes"),
    {
      ...word("drinks", "Drinks"),
      kind: "category",
      subBoardId: "drinks-page",
    },
    null,
  ],
  subBoards: [
    { id: "drinks-page", size: "large", tiles: [word("water", "Water"), null] },
  ],
};
const layout = { columns: 2, size: null };
const unreadable = "{unreadable saved board";
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
});
const results = [];
const click = (page, name) =>
  page.getByRole("button", { name, exact: true }).click();
async function enter(page, name) {
  await click(page, "Caregiver controls");
  await click(page, name);
}
async function stored(page) {
  return page.evaluate(() => ({
    board: localStorage.getItem("sayboard-v2"),
    layout: JSON.parse(localStorage.getItem("sayboard-device-layout-v1")),
    recovery: localStorage.getItem("sayboard-recovery-before-categories"),
  }));
}
async function swapYes(page, index) {
  await click(page, "Select Yes, slot 1");
  await page
    .getByLabel("Destination slot", { exact: true })
    .selectOption(index);
  await click(page, "Move / swap slot");
}
async function blocksUnload(page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}
async function cancelArrangement(page) {
  await click(page, "Cancel arrangement");
  await click(page, "Confirm");
}
try {
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    for (const scenario of [
      "sessions",
      "reset",
      "import",
      "account",
      "late-import",
    ]) {
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/api/auth/capabilities", (route) =>
          route.fulfill({
            json: { state: scenario === "account" ? "enabled" : "disabled" },
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
        await page.route("**/api/board", (route) => {
          assert.equal(route.request().method(), "GET");
          return route.fulfill({ json: { board: fixture, revision: 1 } });
        });
        await page.addInitScript(
          ({ fixture, layout, raw }) => {
            if (localStorage.getItem("sayboard-v2") === null) {
              localStorage.setItem("sayboard-v2", raw);
              localStorage.setItem("sayboard-v1", JSON.stringify(fixture));
              localStorage.setItem(
                "sayboard-device-layout-v1",
                JSON.stringify(layout),
              );
            }
            window.__failBoardSave = false;
            const setItem = Storage.prototype.setItem;
            Storage.prototype.setItem = function (key, value) {
              if (key === "sayboard-v2" && window.__failBoardSave)
                throw new DOMException(
                  "Fixture quota failure",
                  "QuotaExceededError",
                );
              return setItem.call(this, key, value);
            };
            speechSynthesis.getVoices = () => [];
          },
          {
            fixture,
            layout,
            raw: scenario === "sessions" ? JSON.stringify(fixture) : unreadable,
          },
        );
        await page.goto(origin);

        if (scenario === "sessions") {
          await enter(page, "Edit board and settings");
          await page
            .getByText("Display and tile size", { exact: true })
            .click();
          await page
            .getByLabel(/Board columns on this device/)
            .selectOption("3");
          assert.equal(await blocksUnload(page), true);
          await click(page, "Back to board");
          await click(page, "Cancel");
          assert.equal(
            await page.locator(".editor-save-state").textContent(),
            "Unsaved changes on this device",
          );
          await click(page, "Back to board");
          await click(page, "Confirm");
          assert.deepEqual((await stored(page)).layout, layout);

          await click(page, "Add tile to Home board");
          await click(page, "Cancel");
          await enter(page, "Edit board and settings");
          assert.equal(
            await page.locator(".editor-save-state").textContent(),
            "No unsaved changes",
          );
          assert.equal(await page.locator(".settings-group[open]").count(), 0);
          await click(page, "Back to board");
          await click(page, "Add tile to Home board");
          await page
            .getByLabel("Text on the tile", { exact: true })
            .fill("Retained word");
          await page.evaluate(() => {
            window.__failBoardSave = true;
          });
          await click(page, "Save to board");
          await page
            .locator(".dialog-error")
            .filter({ hasText: "kept in the caregiver draft" })
            .waitFor();
          await page.keyboard.press("Escape");
          await page
            .getByRole("button", { name: "Edit Retained word", exact: true })
            .waitFor();
          assert.equal(await blocksUnload(page), true);
          assert.deepEqual(JSON.parse((await stored(page)).board), fixture);
          await page.evaluate(() => {
            window.__failBoardSave = false;
          });
          await click(page, "Save board");
          const retained = JSON.parse((await stored(page)).board);
          assert.equal(
            retained.tiles.filter((tile) => tile?.label === "Retained word")
              .length,
            1,
          );
          assert.deepEqual((await stored(page)).layout, layout);

          await click(page, "Add tile to Home board");
          await page
            .getByLabel("Text on the tile", { exact: true })
            .fill("Retried word");
          await page.evaluate(() => {
            window.__failBoardSave = true;
          });
          await click(page, "Save to board");
          await page
            .locator(".dialog-error")
            .filter({ hasText: "kept in the caregiver draft" })
            .waitFor();
          await page.evaluate(() => {
            window.__failBoardSave = false;
          });
          await click(page, "Retry save");
          await page
            .getByRole("button", { name: "Say Retried word", exact: true })
            .waitFor();
          const saved = JSON.parse((await stored(page)).board);
          assert.equal(
            saved.tiles.filter((tile) => tile?.label === "Retried word").length,
            1,
          );

          await enter(page, "Arrange board");
          await swapYes(page, "1");
          assert.equal(await blocksUnload(page), true);
          await cancelArrangement(page);
          assert.deepEqual(JSON.parse((await stored(page)).board), saved);
          await enter(page, "Arrange board");
          await swapYes(page, "1");
          await click(page, "Save arrangement");
          const arranged = JSON.parse((await stored(page)).board);
          assert.equal(arranged.tiles[0].kind, "category");
          assert.equal(arranged.tiles[1].id, "yes");
          assert.deepEqual(arranged.subBoards, fixture.subBoards);
          arranged.tiles.find((tile) => tile?.label === "Retained word").id =
            "new-word";
          arranged.tiles.find((tile) => tile?.label === "Retried word").id =
            "retried-word";
          results.push({
            viewport,
            scenario,
            board: arranged,
            layout: (await stored(page)).layout,
          });
        } else {
          if (scenario === "reset") {
            await enter(page, "Arrange board");
            await swapYes(page, "1");
            await click(page, "Save arrangement");
            assert.equal((await stored(page)).board, unreadable);
            await cancelArrangement(page);
          }
          await enter(page, "Edit board and settings");
          await click(page, "Save board");
          assert.equal((await stored(page)).board, unreadable);
          await page
            .locator("#status")
            .filter({ hasText: "saved board is retained" })
            .waitFor();

          if (scenario === "reset") {
            await click(page, "Reset to starter words");
          } else {
            await page
              .getByText("Backup and transfer", { exact: true })
              .click();
            if (scenario === "import" || scenario === "late-import") {
              if (scenario === "late-import") {
                await page.evaluate((board) => {
                  File.prototype.text = function () {
                    return new Promise((resolve) => {
                      window.__finishImport = () =>
                        resolve(JSON.stringify(board));
                    });
                  };
                }, fixture);
              }
              await page.locator("#import").setInputFiles({
                name: "fixture-board.json",
                mimeType: "application/json",
                buffer: Buffer.from(JSON.stringify(fixture)),
              });
              if (scenario === "late-import") {
                await page.waitForFunction(
                  () => typeof window.__finishImport === "function",
                );
                await click(page, "Back to board");
                await enter(page, "Arrange board");
                await page.evaluate(() => window.__finishImport());
              }
            } else {
              await click(page, "Load account board");
            }
          }
          await click(page, "Confirm");
          if (scenario === "late-import") {
            await page
              .getByRole("button", { name: "Back to board", exact: true })
              .waitFor();
            await page
              .getByRole("heading", { name: "Arrange board", exact: true })
              .waitFor();
            await click(page, "Save arrangement");
            assert.equal((await stored(page)).board, unreadable);
            await cancelArrangement(page);
          }
          await page
            .locator(".editor-save-state")
            .filter({ hasText: "Unsaved changes on this device" })
            .waitFor();
          assert.equal((await stored(page)).board, unreadable);
          assert.equal(
            await page.locator(".editor-save-state").textContent(),
            "Unsaved changes on this device",
          );
          await click(page, "Save board");
          await page
            .getByRole("button", { name: "Caregiver controls", exact: true })
            .waitFor();
          const saved = await stored(page);
          assert.equal(saved.recovery, unreadable);
          const board = JSON.parse(saved.board);
          if (scenario === "reset")
            assert.equal(board.tiles[0].id, "starter-0");
          else assert.deepEqual(board, fixture);
          assert.deepEqual(saved.layout, layout);
          results.push({
            viewport,
            scenario,
            board,
            layout: saved.layout,
            recovery: saved.recovery,
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
