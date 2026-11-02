import nodemailer from "nodemailer";
import type { Invitation } from "./onboarding.js";

export type InvitationMail = Invitation & { to: string; url: string };
export type AccountMail = {
  kind: "email";
  purpose: "signup" | "reset" | "link";
  to: string;
  url: string;
  expiresAt: number;
};
export interface Mailer {
  send(message: InvitationMail | AccountMail): Promise<void>;
  verify(): Promise<void>;
}
export function emailAddress(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,63}$/i.test(
      value.trim(),
    )
  )
    throw new Error("Invalid email address");
  const normal = value.trim().toLowerCase();
  const [local, domain] = normal.split("@");
  if (
    local.length > 64 ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    domain
      .split(".")
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new Error("Invalid email address");
  return normal;
}
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char,
  );
export function invitationMessage(message: InvitationMail) {
  const reset = message.kind === "reset";
  const title = reset
    ? "Reset your Sayboard password"
    : "You have been invited to Sayboard";
  const action = reset ? "Choose a new password" : "Accept your invitation";
  const intro = reset
    ? "Your pilot organiser created a password reset link for your teacher account."
    : "Your pilot organiser invited you to Sayboard's teacher pilot. Choose your own password to begin.";
  const expiry = new Date(message.expiresAt).toUTCString();
  const text = `${title}\n\n${intro}\n\nTeacher username: ${message.username}\n\n${action}:\n${message.url}\n\nThis private, single-use link expires ${expiry}.\n\nIf you were not expecting this email, ignore it and contact your pilot organiser through your usual channel. It contains no learner boards or speech history.\n`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head><body style="margin:0;background:#f6f6ef;color:#193d35;font:16px/1.6 Arial,sans-serif"><main style="max-width:560px;margin:32px auto;padding:32px;background:#fffefa;border:1px solid #c4d0c5;border-radius:16px"><p style="font-weight:bold">sayboard</p><h1 style="font-size:28px;line-height:1.2">${title}</h1><p>${intro}</p><p>Teacher username: <strong>${escape(message.username)}</strong></p><p><a href="${escape(message.url)}" style="display:inline-block;padding:14px 20px;border-radius:8px;background:#1f5144;color:white;text-decoration:none;font-weight:bold">${action}</a></p><p>This private link works once and expires ${expiry}.</p><p style="font-size:14px">If you were not expecting this email, ignore it and contact your pilot organiser through your usual channel.</p><p style="font-size:14px">This email contains no learner boards or speech history.</p></main></body></html>`;
  return { subject: title, text, html };
}
export function accountMessage(message: AccountMail) {
  const title = {
    signup: "Create your Sayboard workspace",
    reset: "Recover your Sayboard workspace",
    link: "Add your Sayboard recovery email",
  }[message.purpose];
  const intro =
    message.purpose === "link"
      ? "Sign in to the teacher account shown on the page and confirm its current password to add this email."
      : "Open this link to continue if this action is available for your email address.";
  const expiry = new Date(message.expiresAt).toUTCString();
  return {
    subject: title,
    text: `${title}\n\n${intro}\n\n${message.url}\n\nThis private link expires ${expiry}. If you did not request it, ignore this email.\n`,
    html: `<!doctype html><html lang="en"><body><h1>${title}</h1><p>${intro}</p><p><a href="${escape(message.url)}">Continue to Sayboard</a></p><p>This private link expires ${expiry}. If you did not request it, ignore this email.</p></body></html>`,
  };
}
export function configuredMailer(env: NodeJS.ProcessEnv): Mailer | null {
  try {
    return smtpMailer(env);
  } catch {
    return null;
  }
}
export function smtpMailer(env: NodeJS.ProcessEnv): Mailer | null {
  const host = env.SAYBOARD_SMTP_HOST;
  if (!host) return null;
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error("Invalid SMTP host");
  const port = Number(env.SAYBOARD_SMTP_PORT ?? "587");
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !env.SAYBOARD_SMTP_USER ||
    !env.SAYBOARD_SMTP_PASSWORD
  )
    throw new Error("SMTP credentials are incomplete");
  const from = emailAddress(env.SAYBOARD_EMAIL_FROM);
  const replyTo = env.SAYBOARD_EMAIL_REPLY_TO
    ? emailAddress(env.SAYBOARD_EMAIL_REPLY_TO)
    : undefined;
  const makeTransport = () =>
    nodemailer.createTransport({
      host,
      port,
      secure: [465, 2465].includes(port),
      requireTLS: true,
      auth: { user: env.SAYBOARD_SMTP_USER, pass: env.SAYBOARD_SMTP_PASSWORD },
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 12000,
    });
  return {
    async send(message) {
      const transport = makeTransport();
      try {
        const result = await transport.sendMail({
          from: { name: "Sayboard", address: from },
          replyTo,
          to: emailAddress(message.to),
          ...(message.kind === "email"
            ? accountMessage(message)
            : invitationMessage(message)),
        });
        if (result.rejected.length || !result.accepted.length)
          throw new Error("Email was not accepted");
      } finally {
        transport.close();
      }
    },
    async verify() {
      const transport = makeTransport();
      try {
        await transport.verify();
      } finally {
        transport.close();
      }
    },
  };
}
