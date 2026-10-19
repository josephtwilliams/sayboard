// Synthetic boards only. Two tabs share one browser profile and its saved board.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.SAYBOARD_PREVIEW_URL || "http://127.0.0.1:5196";
const fixture = {
  version: 2,
  voice: "",
  rate: 0.85,
  size: "standard",
  tiles: Array.from({ length: 6 }, (_, i) => ({
    kind: "word",
    id: `fixture-${i}`,
    label: `Fixture ${i}`,
    phrase: `Fixture ${i}`,
    icon: "check",
    tone: "mint",
  })),
  subBoards: [],
};
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
});
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  context.setDefaultTimeout(7000);
  await context.addInitScript((board) => {
    if (!localStorage.getItem("sayboard-v2"))
      localStorage.setItem("sayboard-v2", JSON.stringify(board));
    speechSynthesis.speak = () => {};
    speechSynthesis.getVoices = () => [];
  }, fixture);
  const errors = [];
  const open = async () => {
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Say Fixture 0", exact: true })
      .waitFor();
    return page;
  };
  const caregiver = await open();
  const tablet = await open();
  const labels = async (page) =>
    (
      await page.evaluate(() => JSON.parse(localStorage.getItem("sayboard-v2")))
    ).tiles
      .filter(Boolean)
      .map((tile) => tile.label);
  const startQuickAdd = async (page, label) => {
    await page
      .getByRole("button", { name: "Add tile to Home board", exact: true })
      .click();
    const proceed = page.getByRole("button", {
      name: "Continue to add tile",
      exact: true,
    });
    const form = page.getByLabel("Text on the tile", { exact: true });
    await proceed.or(form).waitFor();
    if (await proceed.isVisible()) await proceed.click();
    await form.fill(label);
  };
  const saveQuickAdd = (page) =>
    page.getByRole("button", { name: "Save to board", exact: true }).click();
  const quickAdd = async (page, label) => {
    await startQuickAdd(page, label);
    await saveQuickAdd(page);
    await page.locator("dialog").waitFor({ state: "detached" });
  };

  // A tab left open on the board must not save its old copy over newer edits.
  await quickAdd(caregiver, "Caregiver word");
  await quickAdd(tablet, "Tablet word");
  const saved = await labels(tablet);
  assert.ok(saved.includes("Caregiver word"), `Lost edit: ${saved}`);
  assert.ok(saved.includes("Tablet word"), `Lost edit: ${saved}`);
  await tablet
    .getByRole("button", { name: "Say Caregiver word", exact: true })
    .waitFor();
  await caregiver
    .getByRole("button", { name: "Say Tablet word", exact: true })
    .waitFor();

  // An open draft keeps its changes but cannot replace a board saved since.
  await startQuickAdd(tablet, "Late word");
  await quickAdd(caregiver, "Second caregiver word");
  await saveQuickAdd(tablet);
  await tablet
    .locator("dialog[open]")
    .getByText(/another tab or window/)
    .waitFor();
  const kept = await labels(caregiver);
  assert.ok(kept.includes("Second caregiver word"), `Lost edit: ${kept}`);
  assert.ok(!kept.includes("Late word"), `Stale draft saved: ${kept}`);
  assert.equal(
    await tablet.getByLabel("Text on the tile", { exact: true }).inputValue(),
    "Late word",
  );
  await tablet.getByRole("button", { name: "Cancel", exact: true }).click();
  await tablet
    .getByRole("button", { name: "Back to board", exact: true })
    .click();
  await tablet.getByRole("button", { name: "Confirm", exact: true }).click();
  await tablet.getByText(/another tab or window/).waitFor();
  await tablet.reload();
  await tablet
    .getByRole("button", { name: "Say Second caregiver word", exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, saved: await labels(tablet) }));
} finally {
  await browser.close();
}
