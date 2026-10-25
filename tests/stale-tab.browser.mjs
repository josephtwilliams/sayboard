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
    window.__utterances = [];
    window.__cancels = 0;
    window.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
      }
    };
    speechSynthesis.getVoices = () => [
      {
        name: "Synthetic voice",
        voiceURI: "fixture",
        lang: "en-US",
        localService: true,
        default: true,
      },
    ];
    speechSynthesis.cancel = () => {
      window.__cancels++;
    };
    speechSynthesis.speak = (utterance) => {
      window.__utterances.push(utterance);
      utterance.onstart?.();
    };
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

  // Cross-tab saves must not replace a focused input, even after the quiet
  // period; an unsaid message and its subsequent speech both keep it pending.
  const input = tablet.getByLabel("Type something to say", { exact: true });
  await input.fill("Synthetic message in progress");
  const originalInput = await input.elementHandle();
  await quickAdd(caregiver, "Deferred caregiver word");
  await tablet.waitForTimeout(2600);
  assert.equal(await originalInput.evaluate((node) => node.isConnected), true);
  assert.equal(
    await input.evaluate((node) => node === document.activeElement),
    true,
  );
  assert.equal(await input.inputValue(), "Synthetic message in progress");
  assert.equal(
    await tablet
      .getByRole("button", { name: "Say Deferred caregiver word", exact: true })
      .count(),
    0,
  );
  await input.press("Enter");
  await tablet.waitForTimeout(2600);
  assert.equal(await originalInput.evaluate((node) => node.isConnected), true);
  assert.equal(
    await tablet
      .getByRole("button", { name: "Say Deferred caregiver word", exact: true })
      .count(),
    0,
  );
  assert.equal(await tablet.evaluate(() => window.__utterances.length), 1);
  const cancels = await tablet.evaluate(() => window.__cancels);
  await tablet.evaluate(() => window.__utterances.at(-1).onend?.());
  await tablet
    .getByRole("button", { name: "Say Deferred caregiver word", exact: true })
    .waitFor();
  assert.equal(await input.inputValue(), "Synthetic message in progress");
  assert.equal(await tablet.evaluate(() => window.__utterances.length), 1);
  assert.equal(await tablet.evaluate(() => window.__cancels), cancels);

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
  // A queued storage event can arrive after this tab applies a newer classroom
  // publication. Replay a real event held at the event boundary, not a mock save.
  const linkedContext = await browser.newContext();
  const profileId = "00000000-0000-4000-8000-000000000001";
  let publishedVersion = 1;
  const publication = structuredClone(fixture);
  publication.tiles[0].label = publication.tiles[0].phrase = "New publication";
  await linkedContext.route("**/api/device/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith("/sync")
      ? {
          profileId,
          label: "Synthetic class",
          version: publishedVersion,
          csrfToken: "a".repeat(64),
        }
      : path.endsWith("/board")
        ? {
            profileId,
            label: "Synthetic class",
            version: publishedVersion,
            csrfToken: "a".repeat(64),
            board: publication,
          }
        : {};
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  await linkedContext.addInitScript(
    ({ fixture, profileId }) => {
      if (!localStorage.getItem("sayboard-v2")) {
        localStorage.setItem("sayboard-v2", JSON.stringify(fixture));
        localStorage.setItem(
          "sayboard-classroom-link",
          JSON.stringify({ profileId, version: 1 }),
        );
      }
      window.__heldEvents = [];
      window.__holdStorage = false;
      window.addEventListener(
        "storage",
        (event) => {
          if (window.__holdStorage && event.key === "sayboard-v2") {
            window.__heldEvents.push({
              key: event.key,
              oldValue: event.oldValue,
              newValue: event.newValue,
              url: event.url,
            });
            event.stopImmediatePropagation();
          }
        },
        true,
      );
    },
    { fixture, profileId },
  );
  const linked = await linkedContext.newPage();
  linked.on("pageerror", (error) => errors.push(error.message));
  await linked.goto(origin);
  await linked
    .getByText("Classroom version 1. Automatic updates", { exact: true })
    .waitFor();
  const writer = await linkedContext.newPage();
  await writer.goto(origin);
  await linked.evaluate(() => {
    window.__holdStorage = true;
  });
  await writer.evaluate(() => {
    const old = JSON.parse(localStorage.getItem("sayboard-v2"));
    old.tiles[0].label = old.tiles[0].phrase = "Old queued board";
    localStorage.setItem("sayboard-v2", JSON.stringify(old));
  });
  await linked.waitForFunction(() => window.__heldEvents.length === 1);
  // Stop the second tab's sync client; the tested publication is written locally
  // by the linked page's actual classroom-sync apply callback.
  await writer.close();
  publishedVersion = 2;
  await linked.evaluate(() => window.dispatchEvent(new Event("focus")));
  await linked
    .getByRole("button", { name: "Say New publication", exact: true })
    .waitFor();
  await linked.evaluate(() => {
    window.__holdStorage = false;
    for (const event of window.__heldEvents)
      window.dispatchEvent(
        new StorageEvent("storage", { ...event, storageArea: localStorage }),
      );
  });
  await linked.waitForTimeout(600);
  assert.equal(
    await linked
      .getByRole("button", { name: "Say New publication", exact: true })
      .count(),
    1,
  );
  assert.equal(
    await linked
      .getByRole("button", { name: "Say Old queued board", exact: true })
      .count(),
    0,
  );
  assert.equal(
    (
      await linked.evaluate(() =>
        JSON.parse(localStorage.getItem("sayboard-v2")),
      )
    ).tiles[0].label,
    "New publication",
  );
  await quickAdd(linked, "After publication");
  assert.ok((await labels(linked)).includes("After publication"));
  await linkedContext.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, saved: await labels(tablet) }));
} finally {
  await browser.close();
}
