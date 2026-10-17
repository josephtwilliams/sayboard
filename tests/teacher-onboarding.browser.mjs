import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

export async function checkTeacherOnboarding({
  browser,
  origin,
  username,
  password,
  engine,
  artifactDirectory,
}) {
  const organiser = await browser.newContext({
    ignoreHTTPSErrors: new URL(origin).hostname === "localhost",
    viewport: { width: 1280, height: 900 },
  });
  const teacher = await browser.newContext({
    ignoreHTTPSErrors: new URL(origin).hostname === "localhost",
    viewport:
      engine === "webkit"
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
  });
  const page = await organiser.newPage();
  const join = await teacher.newPage();
  const errors = [];
  for (const target of [page, join]) {
    target.setDefaultTimeout(15000);
    target.on("pageerror", (error) => errors.push(error.message));
  }
  const invited = "invited_" + engine;
  const newPassword = "Synthetic invitation password " + engine;
  const signIn = async (target, user, secret) => {
    await target.goto(origin + "/teacher");
    await target.getByLabel("Teacher username", { exact: true }).fill(user);
    await target.getByLabel("Password", { exact: true }).fill(secret);
    await target.getByRole("button", { name: "Sign in", exact: true }).click();
    await target
      .getByRole("heading", { name: "Your classrooms", exact: true })
      .waitFor();
  };
  try {
    await signIn(page, username, password);
    await page
      .getByRole("heading", { name: "Invite a teacher", exact: true })
      .waitFor();
    await page.getByLabel("Teacher username", { exact: true }).fill(invited);
    await page
      .getByRole("button", { name: "Create private link", exact: true })
      .click();
    const link = await page
      .getByLabel("Private invitation link", { exact: true })
      .inputValue();
    assert.equal(new URL(link).pathname, "/teacher");
    assert.match(new URL(link).hash, /^#activate=[a-f0-9]{64}$/);
    // Previously emailed links must still open the same activation flow.
    const legacyLink = new URL(link);
    legacyLink.pathname = "/teacher.html";
    await join.goto(legacyLink.href);
    assert.equal(new URL(join.url()).pathname, "/teacher");
    await join
      .getByRole("heading", { name: "Welcome to Sayboard", exact: true })
      .waitFor();
    assert.equal(new URL(join.url()).hash, "");
    await join.getByLabel("New password", { exact: true }).fill(newPassword);
    await join
      .getByLabel("Confirm new password", { exact: true })
      .fill(newPassword + " mismatch");
    await join
      .getByRole("button", { name: "Accept invitation", exact: true })
      .click();
    await join
      .getByText("The passwords do not match.", { exact: true })
      .waitFor();
    await join
      .getByLabel("Confirm new password", { exact: true })
      .fill(newPassword);
    await join
      .getByRole("button", { name: "Accept invitation", exact: true })
      .click();
    await join
      .getByRole("heading", { name: "Your password is saved", exact: true })
      .waitFor();
    assert.equal(
      await join.evaluate(() =>
        Object.keys(localStorage).some((key) =>
          /token|session|invite|password/i.test(key),
        ),
      ),
      false,
    );
    await join
      .getByRole("button", { name: "Continue to sign in", exact: true })
      .click();
    assert.equal(
      await join.getByLabel("Teacher username", { exact: true }).inputValue(),
      invited,
    );
    await join.getByLabel("Password", { exact: true }).fill(newPassword);
    await join.getByRole("button", { name: "Sign in", exact: true }).click();
    await join
      .getByRole("heading", {
        name: "Your first classroom, step by step",
        exact: true,
      })
      .waitFor();
    assert.equal(
      await join
        .getByRole("heading", { name: "Invite a teacher", exact: true })
        .count(),
      0,
    );
    if (artifactDirectory) {
      await mkdir(artifactDirectory, { recursive: true });
      await join.screenshot({
        path: artifactDirectory + `/teacher-welcome-${engine}.png`,
        fullPage: true,
      });
    }
    await join.goto(link);
    await join
      .getByRole("heading", { name: "This link is unavailable", exact: true })
      .waitFor();
    await page.getByLabel("Link type", { exact: true }).selectOption("reset");
    await page
      .getByRole("button", { name: "Create private link", exact: true })
      .click();
    await page
      .getByText(
        "Private link created. Share it securely with the intended teacher.",
        { exact: true },
      )
      .waitFor();
    const reset = await page
      .getByLabel("Private invitation link", { exact: true })
      .inputValue();
    assert.notEqual(reset, link);
    await join.goto(reset);
    await join
      .getByRole("heading", { name: "Choose a new password", exact: true })
      .waitFor();
    await join
      .getByLabel("New password", { exact: true })
      .fill(newPassword + " reset");
    await join
      .getByLabel("Confirm new password", { exact: true })
      .fill(newPassword + " reset");
    await join
      .getByRole("button", { name: "Save new password", exact: true })
      .click();
    await join
      .getByRole("heading", { name: "Your password is saved", exact: true })
      .waitFor();
    await signIn(join, invited, newPassword + " reset");
    await join.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    assert.deepEqual(errors, []);
    return {
      engine,
      invited,
      operatorOnlyInvites: true,
      activationTokenRemovedFromUrl: true,
      chooseOwnPassword: true,
      noSecretsInLocalStorage: true,
      onboardingGuide: true,
      replayRejected: true,
      passwordReset: true,
      errors,
    };
  } catch (error) {
    if (artifactDirectory) {
      await mkdir(artifactDirectory, { recursive: true });
      await page.screenshot({
        path: artifactDirectory + `/organiser-failure-${engine}.png`,
        fullPage: true,
      });
      await writeFile(
        artifactDirectory + `/organiser-failure-${engine}.txt`,
        await page.locator("body").innerText(),
      );
    }
    throw error;
  } finally {
    await organiser.close();
    await teacher.close();
  }
}
