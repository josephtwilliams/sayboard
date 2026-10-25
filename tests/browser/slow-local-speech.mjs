// Real app/watchdog with synthetic worker PCM and browser speech boundaries.
// No model download, account, or private vocabulary.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  args: ["--no-sandbox"],
});
try {
  for (const hasDeviceVoice of [false, true]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.install();
    await page.addInitScript((hasDeviceVoice) => {
      window.__localPlays = 0;
      window.__devicePlays = 0;
      window.__generations = [];
      const voice = {
        voiceURI: "synthetic-local",
        name: "Synthetic device voice",
        lang: "en-US",
        localService: true,
        default: true,
      };
      Object.defineProperty(window, "SpeechSynthesisUtterance", {
        value: class {
          constructor(text) {
            this.text = text;
          }
        },
      });
      Object.defineProperty(window, "speechSynthesis", {
        value: {
          getVoices: () => (hasDeviceVoice ? [voice] : []),
          addEventListener() {},
          cancel() {},
          speak(utterance) {
            window.__devicePlays++;
            utterance.onstart?.();
            setTimeout(() => utterance.onend?.(), 10);
          },
        },
      });
      Object.defineProperty(window, "Worker", {
        value: class {
          timers = [];
          postMessage(message) {
            if (message.kind === "load") {
              queueMicrotask(() =>
                this.onmessage?.({ data: { kind: "ready" } }),
              );
            } else {
              window.__generations.push(message.text);
              this.timers.push(
                setTimeout(
                  () =>
                    this.onmessage?.({
                      data: {
                        kind: "audio",
                        id: message.id,
                        samples: new Float32Array([0.1, -0.1]),
                        sampleRate: 24000,
                      },
                    }),
                  20000,
                ),
              );
            }
          }
          terminate() {
            this.timers.forEach(clearTimeout);
          }
        },
      });
      Object.defineProperty(window, "AudioContext", {
        value: class {
          state = "running";
          resume() {
            return Promise.resolve();
          }
          close() {
            return Promise.resolve();
          }
          createBuffer(_channels, length) {
            return { getChannelData: () => new Float32Array(length) };
          }
          createBufferSource() {
            return {
              connect() {},
              disconnect() {},
              stop() {},
              start() {
                window.__localPlays++;
                setTimeout(() => this.onended?.(), 10);
              },
            };
          }
        },
      });
    }, hasDeviceVoice);
    await page.goto(process.env.SAYBOARD_APP_URL || "http://127.0.0.1:5222/");
    await page
      .getByRole("button", { name: "Caregiver controls", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit board and settings", exact: true })
      .click();
    await page.getByText("Voice and speaking speed", { exact: true }).click();
    await page
      .getByRole("button", { name: "Download / load local voice", exact: true })
      .click();
    await page.getByText("Local voice ready.", { exact: false }).waitFor();
    await page
      .getByRole("button", { name: "Back to board", exact: true })
      .click();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.getByRole("button", { name: "Say Yes", exact: true }).click();
    await page.clock.runFor(15001);
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(
      (await page.locator("#status").textContent()).includes("did not finish"),
      false,
    );
    if (!hasDeviceVoice) {
      assert.equal(
        await page.locator(".tile.speaking").count(),
        1,
        "Slow local work remains current after 15 seconds",
      );
    }
    await page.clock.runFor(5100);
    assert.equal(await page.locator("#status").textContent(), "Said: Yes");
    assert.deepEqual(
      await page.evaluate(() => [window.__devicePlays, window.__localPlays]),
      hasDeviceVoice ? [1, 0] : [0, 1],
    );
    await page.clock.runFor(65000);
    assert.equal(await page.locator("#status").textContent(), "Said: Yes");
    assert.deepEqual(
      await page.evaluate(() => [window.__devicePlays, window.__localPlays]),
      hasDeviceVoice ? [1, 0] : [0, 1],
      "No delayed duplicate utterance",
    );

    if (!hasDeviceVoice) {
      const input = page.getByLabel("Type something to say", { exact: true });
      await input.fill("Superseded synthetic phrase");
      await input.press("Enter");
      await input.fill("Latest synthetic phrase");
      await input.press("Enter");
      await page.clock.runFor(20100);
      assert.equal(
        await page.evaluate(() => window.__localPlays),
        1,
        "A newer tap cancels the older pending utterance",
      );
      await page.clock.runFor(20100);
      assert.equal(
        await page.locator("#status").textContent(),
        "Said: Latest synthetic phrase",
      );
      assert.equal(
        await page.evaluate(() => window.__localPlays),
        2,
        "A queued result still speaks once after more than 30 seconds",
      );
      assert.equal(await page.getByRole("dialog").count(), 0);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    "Slow local speech: watchdog, queue wait, cancellation, and no duplicate playback passed.",
  );
} finally {
  await browser.close();
}
