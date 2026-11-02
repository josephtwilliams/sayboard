import { accountClient } from "./account";
import type { EmailPurpose, EmailInspection } from "./email-contract";
import { createElement as el, createButton as button } from "./dom";
export type TeacherEmailState =
  | { kind: "email-inspecting" }
  | { kind: "email-request"; purpose: EmailPurpose }
  | {
      kind: "email-sent";
      purpose: EmailPurpose;
      email: string;
      retryAt: number;
    }
  | { kind: "email-proof"; token: string; view: EmailInspection };
export function teacherEmail(
  state: TeacherEmailState,
  run: (work: () => Promise<void>) => void,
  update: (state: TeacherEmailState) => void,
  finish: () => Promise<void>,
  cancel: () => void,
): HTMLElement {
  const card = el("section", "teacher-card teacher-login");
  if (state.kind === "email-inspecting") {
    card.append(
      el("h1", "", "Checking your email link"),
      button("Back to sign in", cancel),
    );
    return card;
  }
  if (state.kind === "email-sent") {
    card.append(
      el("h1", "", "Check your email"),
      el(
        "p",
        "",
        `Open the link sent to ${state.email} to continue. Email can take a few minutes. Check your spam folder too. Earlier links stay valid until one is used or they expire.`,
      ),
    );
    card.append(
      button("Send another email", () =>
        run(async () => {
          await accountClient.requestEmail(state.purpose, state.email);
          update({ ...state, retryAt: Date.now() + 60_000 });
        }),
      ),
      button("Back", cancel),
    );
    const resend = card.querySelector("button");
    if (resend && Date.now() < state.retryAt) {
      resend.disabled = true;
      setTimeout(() => {
        if (resend.isConnected) resend.disabled = false;
      }, state.retryAt - Date.now());
    }
    return card;
  }
  if (state.kind === "email-proof" && state.view.kind === "unavailable") {
    card.append(
      el("h1", "", "This email link is unavailable"),
      el(
        "p",
        "",
        "It may be expired or already used. Sign in, or request another email from the sign-in page.",
      ),
      button("Back to sign in", cancel),
    );
    return card;
  }
  const form = el("form", "teacher-form");
  const field = (
    labelText: string,
    type: string,
    autocomplete: HTMLInputElement["autocomplete"],
  ) => {
    const label = el("label", "", labelText),
      input = el("input");
    input.type = type;
    input.autocomplete = autocomplete;
    input.required = true;
    input.spellcheck = false;
    input.autocapitalize = "none";
    input.maxLength = type === "password" ? 256 : 254;
    label.append(input);
    form.append(label);
    return input;
  };
  if (state.kind === "email-request") {
    card.append(
      el(
        "h1",
        "",
        state.purpose === "signup"
          ? "Create teacher workspace"
          : state.purpose === "reset"
            ? "Reset your password"
            : "Add recovery email",
      ),
      el(
        "p",
        "",
        state.purpose === "link"
          ? "Open the email link, then confirm your current password to attach this email to your account."
          : "We’ll email you a private link. Open it to choose your password.",
      ),
    );
    const email = field("Email address", "email", "email");
    const submit = el("button", "button primary", "Send email link");
    submit.type = "submit";
    form.append(submit, button("Cancel", cancel));
    form.onsubmit = (event) => {
      event.preventDefault();
      const address = email.value.trim();
      run(async () => {
        await accountClient.requestEmail(state.purpose, address);
        update({
          kind: "email-sent",
          purpose: state.purpose,
          email: address,
          retryAt: Date.now() + 60_000,
        });
      });
    };
  } else if (state.view.kind !== "unavailable") {
    const view = state.view;
    card.append(
      el(
        "h1",
        "",
        view.kind === "link"
          ? "Confirm recovery email"
          : "Choose your password",
      ),
      el(
        "p",
        "",
        view.kind === "link"
          ? `Add ${view.email} to teacher account ${view.username}. Confirm only if this is your account.`
          : `Continue with ${view.email}. Use at least 16 characters.`,
      ),
    );
    const current = accountClient.currentSession();
    if (view.kind === "link" && current?.account.username !== view.username) {
      card.append(
        el(
          "p",
          "",
          "Sign in to the teacher account shown above, then confirm its current password.",
        ),
      );
      const username = field("Teacher username", "text", "username");
      const password = field("Password", "password", "current-password");
      const submit = el("button", "button primary", "Sign in to confirm");
      submit.type = "submit";
      form.append(submit);
      form.onsubmit = (event) => {
        event.preventDefault();
        const name = username.value.trim(),
          secret = password.value;
        password.value = "";
        run(async () => {
          await accountClient.login(name, secret);
          update(state);
        });
      };
    } else {
      const password = field(
        view.kind === "link" ? "Current password" : "New password",
        "password",
        view.kind === "link" ? "current-password" : "new-password",
      );
      password.minLength = 16;
      const submit = el(
        "button",
        "button primary",
        view.kind === "link" ? "Confirm email" : "Open workspace",
      );
      submit.type = "submit";
      form.append(submit);
      form.onsubmit = (event) => {
        event.preventDefault();
        const secret = password.value;
        password.value = "";
        run(async () => {
          await accountClient.completeEmail(view.kind, state.token, secret);
          await finish();
        });
      };
    }
    form.append(button("Cancel", cancel));
  }
  card.append(form);
  return card;
}
