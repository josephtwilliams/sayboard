// Synthetic board only. No account, download/file chooser or TLS bypass.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const origin = process.env.SAYBOARD_PREVIEW_URL || "http://127.0.0.1:5194";
const results = [];
try {
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1280, height: 900 },
  ]) {
    for (const [fullscreen, fontFamily] of [
      [false, null],
      [true, null],
      [false, "DejaVu Sans"],
      [true, "DejaVu Sans"],
    ]) {
      for (const label of [
        "Drink",
        "A very long category name !!!!!!!!!!!!!!",
      ]) {
        const page = await browser.newPage({ viewport });
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
            {
              ...word("drink", label),
              kind: "category",
              subBoardId: "drinks",
            },
            word("yes", "Yes"),
          ],
          voice: "",
          rate: 1,
          size: "small",
          subBoards: [
            {
              id: "drinks",
              size: "small",
              tiles: Array.from({ length: 20 }, (_, index) =>
                word(`water-${index}`, `Water ${index}`),
              ),
            },
          ],
        };
        await page.addInitScript((value) => {
          localStorage.setItem("sayboard-v2", JSON.stringify(value));
          Object.defineProperty(document, "fullscreenEnabled", {
            value: false,
          });
        }, board);
        await page.goto(origin);
        // Wider system font metrics must not wrap Back / Home and shift tiles.
        if (fontFamily)
          await page.addStyleTag({
            content: ':root { font-family: "DejaVu Sans", sans-serif; }',
          });
        if (fullscreen)
          await page
            .getByRole("button", {
              name: "Enter fullscreen communication board",
            })
            .click();
        assert.equal(
          await page.locator(".board-navigation").count(),
          0,
          "Root has no redundant navigation row",
        );
        const geometry = () =>
          page.locator(".grid").evaluate((n) => ({
            top: n.getBoundingClientRect().top,
            overflow: document.documentElement.scrollWidth > innerWidth,
          }));
        const root = await geometry();
        await page
          .getByRole("button", {
            name: `Open ${label} category`,
            exact: true,
          })
          .click();
        await page
          .getByRole("button", { name: "Back / Home", exact: true })
          .waitFor();
        const category = await geometry();
        assert.ok(
          Math.abs(root.top - category.top) < 1,
          `Grid moved entering ${label}: ${root.top} -> ${category.top}`,
        );
        assert.equal(
          category.overflow,
          false,
          "Long category keeps horizontal bounds",
        );
        assert.equal(
          await page.locator(".header > .board-navigation").count(),
          1,
          "Category navigation occupies header slot",
        );
        if (fullscreen)
          assert.ok(
            await page
              .getByRole("button", { name: "Exit fullscreen", exact: true })
              .isVisible(),
          );
        else
          assert.ok(
            await page
              .getByRole("button", {
                name: "Caregiver controls",
                exact: true,
              })
              .isVisible(),
          );
        if (!fullscreen) {
          await page.evaluate(() => window.scrollTo(0, 400));
          const back = await page
            .getByRole("button", { name: "Back / Home", exact: true })
            .boundingBox();
          assert.ok(
            back && back.y >= 0 && back.y + back.height <= viewport.height,
            "Back remains reachable while the category scrolls",
          );
        }
        await page
          .getByRole("button", { name: "Back / Home", exact: true })
          .click();
        const returned = await geometry();
        assert.ok(
          Math.abs(root.top - returned.top) < 1,
          "Grid moved returning home",
        );
        assert.ok(
          await page
            .getByRole("button", {
              name: `Open ${label} category`,
              exact: true,
            })
            .evaluate((n) => n === document.activeElement),
          "Back restores category focus",
        );
        results.push({
          viewport,
          fullscreen,
          label,
          fontFamily,
          gridTop: root.top,
        });
        await page.close();
      }
    }
  }
  // An accidental double tap opens the category but does not also speak the
  // word that appears under the finger.
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(() => {
    const word = (id, label) => ({
      kind: "word",
      id,
      label,
      phrase: label,
      icon: "emoji:1f4a7",
      tone: "blue",
    });
    localStorage.setItem(
      "sayboard-v2",
      JSON.stringify({
        version: 2,
        tiles: [
          { ...word("drink", "Drink"), kind: "category", subBoardId: "drinks" },
          word("yes", "Yes"),
        ],
        voice: "",
        rate: 1,
        size: "small",
        subBoards: [
          { id: "drinks", size: "small", tiles: [word("water", "Water")] },
        ],
      }),
    );
    window.__spoken = [];
    window.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
      }
    };
    speechSynthesis.getVoices = () => [
      {
        name: "Synthetic local voice",
        voiceURI: "synthetic-local",
        localService: true,
        lang: "en-AU",
      },
    ];
    speechSynthesis.speak = (utterance) => {
      window.__spoken.push(utterance.text);
      utterance.onstart?.();
      utterance.onend?.();
    };
    speechSynthesis.cancel = () => {};
  });
  await page.goto(origin);
  const box = await page
    .getByRole("button", { name: "Open Drink category", exact: true })
    .boundingBox();
  const tap = () =>
    page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await tap();
  await page.waitForTimeout(120);
  await tap();
  await page.waitForTimeout(100);
  assert.ok(
    await page
      .getByRole("button", { name: "Say Water", exact: true })
      .isVisible(),
  );
  assert.deepEqual(
    await page.evaluate(() => window.__spoken),
    [],
    "Double tap on a category does not speak the replacing word",
  );
  await page.waitForTimeout(500);
  await tap();
  assert.deepEqual(await page.evaluate(() => window.__spoken), ["Water"]);
  // Keyboard and switch opens are not the first half of a double tap. The
  // first real pointer selection must work immediately, even after reopening
  // a category that was just opened with a pointer.
  for (const activation of ["Enter", "Space", "switch"]) {
    await page
      .getByRole("button", { name: "Back / Home", exact: true })
      .click();
    const category = page.getByRole("button", {
      name: "Open Drink category",
      exact: true,
    });
    await category.click();
    await page
      .getByRole("button", { name: "Back / Home", exact: true })
      .click();
    await category.evaluate((node) => {
      window.__spoken = [];
      node.addEventListener(
        "click",
        (event) => {
          window.__categoryOpen = {
            time: event.timeStamp,
            detail: event.detail,
          };
        },
        { once: true },
      );
    });
    if (activation === "switch")
      await category.evaluate((node) => node.click());
    else await category.press(activation);
    await page
      .getByRole("button", { name: "Say Water", exact: true })
      .evaluate((node) => {
        node.addEventListener(
          "click",
          (event) => {
            window.__wordTap = { time: event.timeStamp, detail: event.detail };
          },
          { capture: true, once: true },
        );
      });
    await tap();
    const events = await page.evaluate(() => ({
      open: window.__categoryOpen,
      tap: window.__wordTap,
      spoken: window.__spoken,
    }));
    assert.equal(events.open.detail, 0, `${activation} is a non-pointer open`);
    assert.deepEqual(
      events.spoken,
      ["Water"],
      `${activation} allows the next pointer tap`,
    );
    assert.ok(events.tap.detail > 0, "The selection is pointer-originated");
    assert.ok(
      events.tap.time - events.open.time < 400,
      "The pointer tap is inside the guard window",
    );
  }
  await page.close();
  // Below a short category, Type and Speak can move under the finger instead.
  const typed = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  await typed.addInitScript(() => {
    const word = (id, label) => ({
      kind: "word",
      id,
      label,
      phrase: label,
      icon: "emoji:1f4a7",
      tone: "blue",
    });
    localStorage.setItem(
      "sayboard-v2",
      JSON.stringify({
        version: 2,
        tiles: [
          word("yes", "Yes"),
          word("no", "No"),
          word("more", "More"),
          { ...word("drink", "Drink"), kind: "category", subBoardId: "drinks" },
        ],
        voice: "",
        rate: 1,
        size: "small",
        subBoards: [
          { id: "drinks", size: "small", tiles: [word("water", "Water")] },
        ],
      }),
    );
    window.__spoken = [];
    window.SpeechSynthesisUtterance = class {
      constructor(text) {
        this.text = text;
      }
    };
    speechSynthesis.getVoices = () => [
      {
        name: "Synthetic local voice",
        voiceURI: "synthetic-local",
        localService: true,
        lang: "en-AU",
      },
    ];
    speechSynthesis.speak = (utterance) => {
      window.__spoken.push(utterance.text);
      utterance.onstart?.();
      utterance.onend?.();
    };
    speechSynthesis.cancel = () => {};
  });
  await typed.goto(origin);
  await typed.locator(".type-and-speak input").fill("Hello there");
  const drink = typed.getByRole("button", {
    name: "Open Drink category",
    exact: true,
  });
  const tile = await drink.boundingBox();
  await drink.click();
  const speakButton = typed.locator(".type-and-speak button.primary");
  const speakBox = await speakButton.boundingBox();
  const overlap = {
    left: Math.max(tile.x, speakBox.x),
    right: Math.min(tile.x + tile.width, speakBox.x + speakBox.width),
    top: Math.max(tile.y, speakBox.y),
    bottom: Math.min(tile.y + tile.height, speakBox.y + speakBox.height),
  };
  assert.ok(
    overlap.left < overlap.right && overlap.top < overlap.bottom,
    "Speak occupies part of the category tile's place",
  );
  const point = {
    x: (overlap.left + overlap.right) / 2,
    y: (overlap.top + overlap.bottom) / 2,
  };
  await typed.getByRole("button", { name: "Back / Home", exact: true }).click();
  await typed.waitForTimeout(500);
  await typed.mouse.click(point.x, point.y);
  await typed.waitForTimeout(120);
  await typed.mouse.click(point.x, point.y);
  await typed.waitForTimeout(100);
  assert.deepEqual(
    await typed.evaluate(() => window.__spoken),
    [],
    "Double tap on a category does not speak typed text",
  );
  assert.equal(
    await speakButton.evaluate((node) => node === document.activeElement),
    false,
    "Double tap on a category does not focus what replaced it",
  );
  await typed.waitForTimeout(500);
  await speakButton.click();
  assert.deepEqual(await typed.evaluate(() => window.__spoken), [
    "Hello there",
  ]);
  await typed.close();
  console.log(JSON.stringify({ scenarios: results.length, results }, null, 2));
} finally {
  await browser.close();
}
