import assert from "node:assert/strict";

// Uses the caller's authenticated, isolated classroom installation.
export async function checkDirectBoard({
  page,
  context,
  origin,
  profileId,
  engine,
  artifactDirectory,
}) {
  const path = origin + "/api/profiles/" + profileId;
  const original = await (await context.request.get(path)).json();
  const session = await (
    await context.request.get(origin + "/api/auth/session")
  ).json();
  const headers = { Origin: origin, "X-CSRF-Token": session.csrfToken };
  if (
    (await page.evaluate(() => document.documentElement.dataset.theme)) !==
    "dark"
  )
    await page
      .getByRole("button", { name: "Switch to dark mode", exact: true })
      .click();
  const background = await page.evaluate(
    () => getComputedStyle(document.documentElement).backgroundColor,
  );
  await page.getByRole("link", { name: "Board settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit Example hello", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.theme),
    "dark",
  );
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).backgroundColor,
    ),
    background,
  );
  await page.getByRole("button", { name: "Done editing", exact: true }).click();
  await page
    .getByRole("region", { name: "Edit board visually", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.theme),
    "dark",
  );
  assert.equal(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).backgroundColor,
    ),
    background,
  );
  const grid = page.locator(".direct-grid");
  const first = page.getByRole("button", {
    name: "Edit Example hello",
    exact: true,
  });
  await first.scrollIntoViewIfNeeded();
  let start = await first.boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(2, 2, { steps: 10 });
  await page.mouse.up();
  assert.equal(
    await page
      .getByRole("button", { name: "Save draft", exact: true })
      .isDisabled(),
    true,
    "Cancelling a drag does not dirty the board",
  );
  await first.click();
  await page
    .getByLabel("Text on the tile", { exact: true })
    .fill("Inline greeting");
  await page
    .getByLabel("Text to speak", { exact: true })
    .fill("Inline greeting");
  await page
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  const source = page.getByRole("button", {
    name: "Edit Inline greeting",
    exact: true,
  });
  await source.scrollIntoViewIfNeeded();
  start = await source.boundingBox();
  const target = await grid.locator('[data-direct-slot="1"]').boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
  await grid
    .locator('[data-direct-slot="1"]')
    .getByRole("button", { name: "Edit Inline greeting", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Publish", exact: true })
      .isDisabled(),
    true,
  );
  assert.deepEqual(
    (await (await context.request.get(path)).json()).board,
    original.board,
    "Inline edits and drags must not autosave or publish",
  );
  const handle = page.getByRole("button", {
    name: "Move Inline greeting",
    exact: true,
  });
  await handle.focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("Destination slot", { exact: true }).selectOption("20");
  await page.getByRole("button", { name: "Move tile", exact: true }).click();
  await grid
    .locator('[data-direct-slot="20"]')
    .getByRole("button", { name: "Edit Inline greeting", exact: true })
    .waitFor();
  const saveURL = "**/api/profiles/" + profileId;
  await context.route(saveURL, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 503, json: { error: "storage_unavailable" } })
      : route.continue(),
  );
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page.locator(".teacher-status.error").waitFor();
  await grid
    .locator('[data-direct-slot="20"]')
    .getByRole("button", { name: "Edit Inline greeting", exact: true })
    .waitFor();
  await context.unroute(saveURL);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page
    .locator(".teacher-status")
    .filter({ hasText: "Classroom draft saved" })
    .waitFor();
  const saved = await (await context.request.get(path)).json();
  assert.equal(saved.board.tiles[20].label, "Inline greeting");
  assert.equal(
    saved.board.tiles[1],
    null,
    "Moving a tile leaves its old slot empty",
  );
  assert.equal(
    saved.publishedVersion,
    original.publishedVersion,
    "Saving must not publish",
  );
  await page.getByRole("button", { name: "Add category", exact: true }).click();
  await page.getByLabel("Category name", { exact: true }).fill("Practice");
  await page
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open Practice category", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add word or phrase", exact: true })
    .click();
  await page
    .getByLabel("Text on the tile", { exact: true })
    .fill("Again please");
  await page
    .getByRole("button", { name: "Apply changes", exact: true })
    .click();
  await page.getByRole("link", { name: "Devices", exact: true }).click();
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Practice category", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit Again please", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Home board", exact: true }).click();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page
    .locator(".teacher-status")
    .filter({ hasText: "Classroom draft saved" })
    .waitFor();
  const categorySaved = await (await context.request.get(path)).json();
  const practice = categorySaved.board.tiles.find(
    (tile) => tile?.label === "Practice",
  );
  assert.equal(
    categorySaved.board.subBoards.find(
      (board) => board.id === practice.subBoardId,
    ).tiles[0].phrase,
    "Again please",
  );
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "Direct editing fits " + width + "px",
    );
  }
  await page.setViewportSize({
    width: engine === "webkit" ? 390 : 1280,
    height: 900,
  });
  if (artifactDirectory)
    await page.screenshot({
      path: artifactDirectory + `/direct-board-dark-${engine}.png`,
      fullPage: false,
    });
  // Restore the caller's vocabulary for its remaining classroom scenarios.
  const restored = await context.request.put(path, {
    headers,
    data: { revision: categorySaved.revision, board: original.board },
  });
  assert.equal(restored.status(), 200);
  await page.reload();
  await page
    .getByRole("button", { name: "Edit Example hello", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Switch to light mode", exact: true })
    .click();
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.theme),
    "light",
  );
  return {
    themeStableAcrossSettings: true,
    inlineTileEditing: true,
    pointerDrag: true,
    keyboardMove: true,
    categoryEditing: true,
    unsavedEditsSurviveTabs: true,
    cancelledDragKeepsBoard: true,
    failedSaveKeepsEdits: true,
    explicitSaveOnly: true,
  };
}
