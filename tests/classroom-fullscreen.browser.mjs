// Synthetic board and stubbed device sync only. No account or classroom server.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.SAYBOARD_PREVIEW_URL || "http://127.0.0.1:5189";
assert.ok(
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname),
  "Use a local preview with synthetic data",
);
const profileId = "00000000-0000-4000-8000-000000000001";
const word = (id, label) => ({
  kind: "word",
  id,
  label,
  phrase: label,
  icon: "emoji:1f4a7",
  tone: "blue",
});
const board = {
  version: 2,
  tiles: [
    { ...word("drinks", "Drinks"), kind: "category", subBoardId: "drinks" },
    word("yes", "Yes"),
  ],
  voice: "",
  rate: 1,
  size: "small",
  subBoards: [{ id: "drinks", size: "small", tiles: [word("water", "Water")] }],
};
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
});
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  let syncStatus = 200;
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(origin).origin) return route.abort();
    if (url.pathname === "/api/device/sync")
      return route.fulfill({
        status: syncStatus,
        contentType: "application/json",
        body: JSON.stringify({
          profileId,
          label: "Synthetic class",
          version: 1,
          csrfToken: "a".repeat(64),
        }),
      });
    if (url.pathname === "/api/device/applied")
      return route.fulfill({ contentType: "application/json", body: "{}" });
    if (url.pathname.startsWith("/api/"))
      return route.fulfill({ status: 503, body: "{}" });
    return route.continue();
  });
  await context.addInitScript(
    ({ board, link }) => {
      localStorage.setItem("sayboard-v2", JSON.stringify(board));
      localStorage.setItem("sayboard-classroom-link", JSON.stringify(link));
      Object.defineProperty(document, "fullscreenEnabled", { value: false });
    },
    { board, link: { profileId, version: 1 } },
  );
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const indicator = page.locator(".classroom-sync-status");
  const linkedText = "Classroom version 1. Automatic updates";
  const gridTop = () =>
    page.locator(".grid").evaluate((n) => n.getBoundingClientRect().top);
  const afterPolls = async (count) => {
    for (let i = 0; i < count; i++)
      await page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/device/sync",
      );
    await page.waitForTimeout(200);
  };

  await page.goto(origin);
  await page.getByText(linkedText, { exact: true }).waitFor();

  await page
    .getByRole("button", { name: "Enter fullscreen communication board" })
    .click();
  const fullscreenTop = await gridTop();
  assert.equal(await indicator.isHidden(), true, "Fullscreen hides status");
  // Each poll republishes the linked state; it must not reveal hidden chrome.
  await afterPolls(2);
  assert.equal(
    await indicator.isHidden(),
    true,
    "Classroom polls keep the status hidden in fullscreen",
  );
  assert.ok(
    Math.abs((await gridTop()) - fullscreenTop) < 1,
    "Classroom polls must not move the fullscreen board",
  );

  await page
    .getByRole("button", { name: "Open Drinks category", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Back / Home", exact: true })
    .waitFor();
  await afterPolls(1);
  assert.equal(
    await indicator.isHidden(),
    true,
    "Polls after a category render keep the status hidden",
  );
  assert.ok(
    Math.abs((await gridTop()) - fullscreenTop) < 1,
    "Polls must not move the fullscreen category board",
  );

  await page
    .getByRole("button", { name: "Exit fullscreen", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Leave fullscreen", exact: true })
    .click();
  await page.getByText(linkedText, { exact: true }).waitFor();

  syncStatus = 404;
  await indicator.waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      linkedStatusVisible: true,
      fullscreenStatusHiddenAcrossPolls: true,
      fullscreenGridTop: fullscreenTop,
      statusReturnsAfterFullscreen: true,
      unlinkHidesStatus: true,
    }),
  );
} finally {
  await browser.close();
}
