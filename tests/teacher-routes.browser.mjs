import assert from "node:assert/strict";

export async function checkTeacherRoutes({ browser, origin }) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: new URL(origin).hostname === "localhost",
  });
  try {
    for (const method of ["get", "head"]) {
      const clean = await context.request[method](origin + "/teacher");
      assert.equal(clean.status(), 200);
      assert.match(clean.headers()["content-type"], /^text\/html/);
      for (const path of ["/teacher.html", "/teacher/"]) {
        const old = await context.request[method](
          origin + path + "?from=bookmark",
          { maxRedirects: 0 },
        );
        assert.equal(old.status(), 308);
        assert.equal(old.headers().location, "/teacher?from=bookmark");
      }
    }
    const page = await context.newPage();
    await page.goto(origin + "/teacher.html?from=bookmark#route-check");
    assert.equal(page.url(), origin + "/teacher?from=bookmark#route-check");
    await page.getByLabel("Teacher username", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  } finally {
    await context.close();
  }
}
