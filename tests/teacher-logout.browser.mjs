// Synthetic account/session fixtures only; exercises the built teacher UI.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.SAYBOARD_PREVIEW_URL || "http://127.0.0.1:5189/";
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const originalSession = {
  account: { username: "synthetic-teacher" },
  csrfToken: "original-synthetic-token",
  expiresAt: 2_000_000_000,
};
const refreshedSession = {
  ...originalSession,
  account: { username: "refreshed-teacher" },
  csrfToken: "refreshed-synthetic-token",
};

try {
  for (const retryStatus of [403, 401]) {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const logoutTokens = [];
    let sessionReads = 0;
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      let status = 200;
      let response;
      if (path === "/api/auth/capabilities") response = { state: "enabled" };
      else if (path === "/api/auth/google/config")
        response = { enabled: false, signupEnabled: false };
      else if (path === "/api/auth/session") {
        response = ++sessionReads === 1 ? originalSession : refreshedSession;
      } else if (path === "/api/classrooms") {
        response = {
          classrooms: [
            {
              id: "11111111-1111-1111-1111-111111111111",
              name: "Synthetic private classroom",
            },
          ],
        };
      } else if (path === "/api/invitations") response = { operator: false };
      else if (path === "/api/auth/logout") {
        logoutTokens.push(request.headers()["x-csrf-token"]);
        status =
          logoutTokens.length === 1
            ? 403
            : logoutTokens.length === 2
              ? retryStatus
              : 200;
        response =
          status === 200 ? { ok: true } : { error: "synthetic_rejection" };
      } else throw new Error(`Unexpected request: ${path}`);
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(response),
      });
    });
    await page.goto(new URL("teacher.html", origin).href);
    await page
      .getByRole("heading", { name: "Your classrooms", exact: true })
      .waitFor();
    await page
      .getByRole("heading", {
        name: "Synthetic private classroom",
        exact: true,
      })
      .waitFor();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page
      .getByRole("heading", { name: "Teacher sign in", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByText("Synthetic private classroom", { exact: true })
        .count(),
      0,
    );
    assert.deepEqual(logoutTokens, [
      originalSession.csrfToken,
      refreshedSession.csrfToken,
    ]);
    if (retryStatus === 403) {
      await page
        .getByText("Sign out did not finish", { exact: false })
        .waitFor();
      assert.equal(
        await page.locator(".teacher-user").textContent(),
        refreshedSession.account.username,
      );
      const signOut = page.getByRole("button", {
        name: "Sign out",
        exact: true,
      });
      assert.equal(await signOut.isEnabled(), true);
      await signOut.click();
      await page.getByText("Signed out.", { exact: true }).waitFor();
      assert.deepEqual(logoutTokens, [
        originalSession.csrfToken,
        refreshedSession.csrfToken,
        refreshedSession.csrfToken,
      ]);
    }
    assert.equal(
      await page.getByRole("button", { name: "Sign out", exact: true }).count(),
      0,
    );
    assert.equal(await page.locator(".teacher-user").count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    "Teacher logout retry: second 403 is retryable; retry 401 clears identity.",
  );
} finally {
  await browser.close();
}
