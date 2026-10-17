import { it, expect } from "vitest";
import { emailAddress, invitationMessage, smtpMailer } from "../mail.ts";
it("rejects recipient injection and malformed addresses", () => {
  for (const email of [
    "a@example.test\r\nBcc: b@example.test",
    "a@b..test",
    ".a@example.test",
    "a..b@example.test",
    "a@-bad.test",
    "@example.test",
  ])
    expect(() => emailAddress(email)).toThrow();
  expect(emailAddress(" Teacher+pilot@Example.test ")).toBe(
    "teacher+pilot@example.test",
  );
});
it("requires complete authenticated SMTP configuration", () => {
  expect(smtpMailer({})).toBeNull();
  for (const env of [
    { SAYBOARD_SMTP_HOST: "smtp.example.test" },
    {
      SAYBOARD_SMTP_HOST: "smtp.example.test",
      SAYBOARD_SMTP_PORT: "0",
      SAYBOARD_SMTP_USER: "synthetic",
      SAYBOARD_SMTP_PASSWORD: "synthetic",
      SAYBOARD_EMAIL_FROM: "accounts@example.test",
    },
  ])
    expect(() => smtpMailer(env)).toThrow();
});
it("creates accessible transactional HTML and plain text without remote tracking", () => {
  const message = invitationMessage({
    username: "demo<&",
    to: "teacher@example.test",
    kind: "invite",
    expiresAt: Date.UTC(2030, 0, 1),
    url:
      "https://classroom.example.test/teacher#activate=" + "a".repeat(64),
  });
  expect(message.text).toContain("Teacher username: demo<&");
  expect(message.html).toContain("demo&lt;&amp;");
  expect(message.html).toContain('lang="en"');
  expect(message.html).not.toMatch(/<img|<script|<iframe/);
  expect(message.text).toContain("Tue, 01 Jan 2030");
  expect(
    invitationMessage({
      username: "demo",
      to: "teacher@example.test",
      kind: "reset",
      expiresAt: 1,
      url: "https://classroom.example.test",
    }).subject,
  ).toBe("Reset your Sayboard password");
});
