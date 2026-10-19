// Synthetic fixtures only. Never opens browser download/file chooser UI or bypasses TLS.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
const origin = process.env.SAYBOARD_PREVIEW_URL || "http://127.0.0.1:5194";
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
await mkdir("test-results", { recursive: true });
const fixture = {
  version: 2,
  voice: "",
  rate: 0.85,
  size: "standard",
  tiles: [
    {
      kind: "word",
      id: "fixture-yes",
      label: "Yes",
      phrase: "Yes",
      icon: "check",
      tone: "mint",
    },
    null,
  ],
  subBoards: [],
};
const results = [];
try {
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    const page = await browser.newPage({
      viewport,
      hasTouch: viewport.width < 500,
    });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript((value) => {
      if (!localStorage.getItem("sayboard-v2"))
        localStorage.setItem("sayboard-v2", JSON.stringify(value));
      window.__speechCalls = 0;
      speechSynthesis.speak = () => {
        window.__speechCalls++;
      };
      speechSynthesis.getVoices = () => [];
    }, fixture);
    await page.goto(origin);
    const backdrop = async () => {
      if (viewport.width < 500) await page.touchscreen.tap(2, 2);
      else await page.mouse.click(2, 2);
    };
    const noDialog = async () =>
      assert.equal(await page.locator("dialog[open]").count(), 0);
    const snapshot = () =>
      page.evaluate(() => localStorage.getItem("sayboard-v2"));
    const original = await snapshot();
    // Repeated clean entry dismissal restores focus and never reaches speaking tiles.
    for (let i = 0; i < 3; i++) {
      await page
        .getByRole("button", { name: "Caregiver controls", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Caregiver tools", exact: true })
        .click();
      assert.equal(await page.locator("dialog[open]").count(), 1);
      if (i === 1) await page.keyboard.press("Escape");
      else await backdrop();
      await noDialog();
      await page.waitForFunction(
        () =>
          document.activeElement?.getAttribute("aria-label") ===
          "Caregiver controls",
      );
    }
    // Quick add cancellation returns to communication, without creating an editor session.
    await page
      .getByRole("button", { name: "Caregiver controls", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add word or phrase", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: "Save to board", exact: true })
        .isDisabled(),
      true,
    );
    await page.keyboard.press("Escape");
    await noDialog();
    await page
      .getByRole("button", { name: "Caregiver controls", exact: true })
      .waitFor();
    assert.equal(await snapshot(), original);
    // Dirty backdrop and Escape protect edits; keep editing retains the exact values.
    await page
      .getByRole("button", { name: "Caregiver controls", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add word or phrase", exact: true })
      .click();
    await page
      .getByLabel("Text on the tile", { exact: true })
      .fill("Fixture hello");
    assert.equal(
      await page.getByLabel("Text to speak", { exact: true }).inputValue(),
      "Fixture hello",
    );
    await page.screenshot({
      path: `test-results/editor-${viewport.width}.png`,
    });
    await backdrop();
    await page
      .getByRole("button", { name: "Keep editing", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("Text on the tile", { exact: true }).inputValue(),
      "Fixture hello",
    );
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await noDialog();
    await page
      .getByRole("button", { name: "Caregiver controls", exact: true })
      .waitFor();
    assert.equal(await snapshot(), original);
    // Quick add needs one save. Advanced options, symbol navigation and speech text still work.
    await page
      .getByRole("button", { name: "Caregiver controls", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add word or phrase", exact: true })
      .click();
    await page
      .getByLabel("Text on the tile", { exact: true })
      .fill("Fixture water");
    await page
      .getByLabel("Text to speak", { exact: true })
      .fill("Please give me water");
    await page.locator("dialog .symbol-suggestions button").first().focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await page.evaluate(() => document.activeElement?.className),
      "symbol-choice",
    );
    // Native Tab trap remains within dialog, including when controls are collapsed.
    for (let i = 0; i < 16; i++) {
      await page.keyboard.press("Tab");
      assert.equal(
        await page.evaluate(() => !!document.activeElement?.closest("dialog")),
        true,
      );
    }
    await page.getByText("Find another symbol", { exact: true }).click();
    await page.getByLabel("Search symbols", { exact: true }).fill("water");
    await page.locator("dialog .symbol-results button").first().click();
    await page.getByText("Colour and board position", { exact: true }).click();
    await page.getByLabel("Tile colour").selectOption("blue");
    await page
      .getByRole("button", { name: "Save to board", exact: true })
      .click();
    await noDialog();
    await page
      .getByRole("button", { name: "Say Fixture water", exact: true })
      .waitFor();
    let stored = JSON.parse(await snapshot());
    assert.equal(stored.tiles[1].phrase, "Please give me water");
    assert.equal(stored.tiles[1].tone, "blue");
    await page.reload();
    await page
      .getByRole("button", { name: "Say Fixture water", exact: true })
      .waitFor();
    // Settings have native keyboard toggles and persist together with word edits.
    await page
      .getByRole("button", { name: "Caregiver controls", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit board and settings", exact: true })
      .click();
    await page.screenshot({
      path: `test-results/settings-${viewport.width}.png`,
    });
    const display = page.getByText("Display and tile size", { exact: true });
    await display.focus();
    await page.keyboard.press("Enter");
    await page
      .getByLabel("Default tile size for this board")
      .selectOption("large");
    await page.getByLabel("Tile size on this device").selectOption("small");
    await page.getByLabel("Board columns on this device").selectOption("2");
    await page.getByText("Voice and speaking speed", { exact: true }).click();
    const speed = page.getByLabel("Speaking speed", { exact: true });
    await speed.fill("1.1");
    await page.getByText("Backup and transfer", { exact: true }).click();
    assert.equal(
      await page
        .getByRole("button", { name: "Export board", exact: true })
        .isVisible(),
      true,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Import board", exact: true })
        .isVisible(),
      true,
    );
    await page
      .getByRole("button", { name: "Back to board", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await noDialog();
    assert.equal(
      await page
        .getByRole("heading", { name: "Edit board", exact: true })
        .isVisible(),
      true,
    );
    await page.getByRole("button", { name: "Test voice", exact: true }).click();
    await page
      .getByRole("heading", { name: "Speech unavailable", exact: true })
      .waitFor();
    await backdrop();
    await noDialog();
    await page.waitForFunction(
      () => document.activeElement?.textContent === "Test voice",
    );
    await page
      .getByRole("button", { name: "Edit Fixture water", exact: true })
      .click();
    await page
      .getByLabel("Text on the tile", { exact: true })
      .fill("Fixture drink");
    await page
      .getByRole("button", { name: "Apply changes", exact: true })
      .click();
    await noDialog();
    await page.waitForFunction(
      () => document.activeElement?.textContent === "Edit Fixture drink",
    );
    // Dismissing a destructive confirmation cancels the removal and restores its opener.
    await page
      .locator(".edit-row")
      .nth(1)
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await backdrop();
    await noDialog();
    await page.waitForFunction(
      () => document.activeElement?.textContent === "Remove",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Edit Fixture drink", exact: true })
        .count(),
      1,
    );
    assert.equal(JSON.parse(await snapshot()).tiles[1].label, "Fixture water");
    await page.getByRole("button", { name: "Save board", exact: true }).click();
    await page
      .getByRole("button", { name: "Say Fixture drink", exact: true })
      .waitFor();
    stored = JSON.parse(await snapshot());
    assert.equal(stored.tiles[1].label, "Fixture drink");
    assert.equal(stored.rate, 1.1);
    assert.equal(stored.size, "large");
    assert.deepEqual(
      await page.evaluate(() =>
        JSON.parse(localStorage.getItem("sayboard-device-layout-v1")),
      ),
      { columns: 2, size: "small" },
    );
    await page.reload();
    await page
      .getByRole("button", { name: "Say Fixture drink", exact: true })
      .waitFor();
    assert.equal(await page.evaluate(() => window.__speechCalls), 0);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    // Theme remains available; screenshot checks dialog text, sizing and action states.
    await page
      .getByRole("button", { name: "Switch to dark mode", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Caregiver controls", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add word or phrase", exact: true })
      .click();
    await page
      .getByLabel("Text on the tile", { exact: true })
      .fill("Fixture dark");
    await page.screenshot({
      path: `test-results/editor-dark-${viewport.width}.png`,
    });
    const bounds = await page.locator("dialog[open]").boundingBox();
    assert.ok(bounds.x >= 0 && bounds.width <= viewport.width);
    assert.equal(
      await page
        .getByLabel("Text on the tile", { exact: true })
        .evaluate((n) => parseFloat(getComputedStyle(n).fontSize) >= 16),
      true,
    );
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Discard changes", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Caregiver controls", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Caregiver controls", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit board and settings", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add category", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("Text to speak", { exact: true }).isVisible(),
      false,
    );
    await page
      .getByLabel("Text on the tile", { exact: true })
      .fill("Fixture category");
    await page
      .getByRole("button", { name: "Add to board draft", exact: true })
      .click();
    await page.getByRole("button", { name: "Save board", exact: true }).click();
    await page
      .getByRole("button", {
        name: "Open Fixture category category",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Caregiver controls", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add word or phrase", exact: true })
      .click();
    await page
      .getByLabel("Text on the tile", { exact: true })
      .fill("Fixture child");
    await page
      .getByRole("button", { name: "Save to board", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Say Fixture child", exact: true })
      .waitFor();
    assert.equal(
      JSON.parse(await snapshot()).subBoards[0].tiles[0].label,
      "Fixture child",
    );
    await page
      .getByRole("button", { name: "Back / Home", exact: true })
      .click();
    // A write failure must retain the applied word in the caregiver draft after dismissal.
    await page.evaluate(() => {
      const originalSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === "sayboard-v2")
          throw new DOMException("Fixture quota failure", "QuotaExceededError");
        originalSet.call(this, key, value);
      };
    });
    await page
      .getByRole("button", { name: "Caregiver controls", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add word or phrase", exact: true })
      .click();
    await page
      .getByLabel("Text on the tile", { exact: true })
      .fill("Fixture kept draft");
    await page
      .getByRole("button", { name: "Save to board", exact: true })
      .click();
    await page
      .locator(".dialog-error")
      .filter({ hasText: "kept in the caregiver draft" })
      .waitFor();
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Edit Fixture kept draft", exact: true })
      .waitFor();
    assert.equal(
      JSON.parse(await snapshot()).tiles.some(
        (t) => t?.label === "Fixture kept draft",
      ),
      false,
    );
    assert.deepEqual(errors, []);
    results.push({ viewport, passed: true });
    await page.close();
  }
  // Voices that arrive after startup without voiceschanged still reach the picker.
  const voicePage = await browser.newPage();
  voicePage.setDefaultTimeout(5000);
  const voiceErrors = [];
  voicePage.on("pageerror", (e) => voiceErrors.push(e.message));
  await voicePage.addInitScript(
    (value) => {
      localStorage.setItem("sayboard-v2", JSON.stringify(value));
      window.__voices = [];
      Object.defineProperty(window, "speechSynthesis", {
        value: {
          getVoices: () => window.__voices,
          addEventListener: () => {},
          cancel: () => {},
          speak: () => {},
        },
      });
    },
    { ...fixture, voice: "late-saved" },
  );
  await voicePage.goto(origin);
  await voicePage
    .getByRole("button", { name: "Caregiver controls", exact: true })
    .click();
  await voicePage.evaluate(() => {
    window.__voices = [
      {
        voiceURI: "late-other",
        name: "Other",
        lang: "en-US",
        localService: true,
      },
      {
        voiceURI: "late-saved",
        name: "Saved",
        lang: "en-GB",
        localService: true,
      },
    ];
  });
  await voicePage
    .getByRole("button", { name: "Edit board and settings", exact: true })
    .click();
  await voicePage
    .getByText("Voice and speaking speed", { exact: true })
    .click();
  const voiceSelect = voicePage.getByLabel(
    "Device voice for speech and fallback",
  );
  assert.deepEqual(
    await voiceSelect
      .locator("option")
      .evaluateAll((options) => options.map((option) => option.value)),
    ["", "late-other", "late-saved"],
  );
  assert.equal(await voiceSelect.inputValue(), "late-saved");
  await voiceSelect.selectOption("late-other");
  await voicePage
    .getByRole("button", { name: "Save board", exact: true })
    .click();
  await voicePage
    .getByRole("button", { name: "Caregiver controls", exact: true })
    .waitFor();
  assert.equal(
    await voicePage.evaluate(
      () => JSON.parse(localStorage.getItem("sayboard-v2")).voice,
    ),
    "late-other",
  );
  assert.deepEqual(voiceErrors, []);
  await voicePage.close();
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
