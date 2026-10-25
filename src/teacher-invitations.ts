import { createElement as el, createButton as button } from "./dom";
import { accountClient } from "./account";
import { record, text, integer } from "./classroom-contract";

async function request(
  path: string,
  value?: unknown,
  method = value === undefined ? "GET" : "POST",
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
      headers:
        value === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              "X-CSRF-Token": accountClient.currentSession()?.csrfToken ?? "",
            },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  } catch {
    throw new Error(
      "The account service could not be reached. Try again when connected.",
    );
  }
  if (!response.ok)
    throw new Error(
      response.status === 410
        ? "This link has expired or has already been used. Ask your pilot organiser for a new one."
        : response.status === 409
          ? path === "/api/auth/activation"
            ? "An account with this username already exists. Ask your pilot organiser for a password reset link."
            : "That username already exists, or cannot be reset. Check it and try again."
          : response.status === 429
            ? "Too many attempts. Wait five minutes before trying again."
            : response.status === 403
              ? "Only the pilot organiser can invite teachers or issue reset links."
              : "This account request could not be completed. Try again or contact your pilot organiser.",
    );
  return response.json();
}
// Browsers compile pattern attributes with the v flag, which rejects an
// unescaped "-" in a character class and then skips the check entirely.
// Surrounding spaces, as in a pasted name, are trimmed before sending.
export const usernamePattern = "\\s*[a-zA-Z0-9_\\-]+\\s*";
export async function canInvite(): Promise<boolean> {
  return record(await request("/api/invitations")).operator === true;
}
function field(labelText: string, type = "text") {
  const label = el("label", "teacher-link-field", labelText);
  const input = el("input");
  input.type = type;
  label.append(input);
  return { label, input };
}
export function createInvitationsPanel() {
  const section = el("section", "teacher-card teacher-invitations");
  section.append(
    el("h2", "", "Invite a teacher"),
    el(
      "p",
      "",
      "Teachers choose their own passwords. Invitations expire after 48 hours; reset links expire after one hour.",
    ),
  );
  const form = el("form", "teacher-form");
  const user = field("Teacher username");
  user.input.required = true;
  user.input.maxLength = 64;
  user.input.pattern = usernamePattern;
  user.input.autocapitalize = "none";
  user.input.spellcheck = false;
  const kindLabel = el("label", "", "Link type");
  const kind = el("select");
  kind.setAttribute("aria-label", "Link type");
  for (const [value, name] of [
    ["invite", "New teacher invitation"],
    ["reset", "Existing teacher password reset"],
  ]) {
    const option = el("option", "", name);
    option.value = value;
    kind.append(option);
  }
  kindLabel.append(kind);
  const deliveryLabel = el("label", "", "Delivery");
  const delivery = el("select");
  delivery.setAttribute("aria-label", "Delivery");
  const privateOption = el("option", "", "Private link to share yourself");
  privateOption.value = "link";
  delivery.append(privateOption);
  deliveryLabel.append(delivery);
  const email = field("Teacher email address", "email");
  email.input.maxLength = 254;
  email.label.hidden = true;
  delivery.onchange = () => {
    email.label.hidden = delivery.value !== "email";
    email.input.required = delivery.value === "email";
    submit.textContent =
      delivery.value === "email"
        ? "Send private link by email"
        : "Create private link";
  };
  const submit = el("button", "button primary", "Create private link");
  submit.type = "submit";
  const status = el("p", "teacher-status");
  status.role = "status";
  const result = el("div");
  let busy = false;
  function setBusy(value: boolean) {
    busy = value;
    form
      .querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLButtonElement
      >("input,select,button")
      .forEach((control) => {
        control.disabled = value;
      });
  }
  form.append(user.label, kindLabel, deliveryLabel, email.label, submit);
  const cancel = button("Cancel pending link", () => {
    if (busy) return;
    const username = user.input.value.trim();
    if (!username || !user.input.checkValidity()) {
      user.input.reportValidity();
      return;
    }
    setBusy(true);
    void request("/api/invitations", { username }, "DELETE")
      .then(() => {
        result.replaceChildren();
        status.textContent =
          "Any unused link you created for this username is cancelled. An existing account is unchanged.";
      })
      .catch((error: unknown) => {
        status.textContent =
          error instanceof Error ? error.message : "Cancellation failed.";
      })
      .finally(() => {
        setBusy(false);
      });
  });
  form.append(cancel);
  section.append(form, status, result);
  void request("/api/invitations")
    .then((value) => {
      if (record(value).emailEnabled === true) {
        const option = el("option", "", "Email the teacher");
        option.value = "email";
        delivery.append(option);
      } else
        status.textContent =
          "Email delivery is not configured on this server. You can create a private link to share securely.";
    })
    .catch(() => {
      status.textContent =
        "Could not check email availability. Private invitation links remain available.";
    });
  form.onsubmit = (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    result.replaceChildren();
    void (async () => {
      try {
        const response = record(
          await request("/api/invitations", {
            username: user.input.value.trim(),
            kind: kind.value,
            delivery: delivery.value,
            ...(delivery.value === "email"
              ? { email: email.input.value.trim() }
              : {}),
          }),
        );
        const url = new URL(text(response.url, 400));
        if (
          url.origin !== location.origin ||
          url.pathname !== "/teacher" ||
          !/^#activate=[a-f0-9]{64}$/.test(url.hash)
        )
          throw new Error("The invitation response was invalid.");
        const expiry = integer(response.expiresAt);
        const link = field("Private invitation link");
        link.input.value = url.href;
        link.input.readOnly = true;
        link.input.onclick = () => link.input.select();
        result.append(
          link.label,
          button("Copy private link", () => {
            void navigator.clipboard
              .writeText(url.href)
              .then(() => {
                status.textContent =
                  "Private link copied. Share it only with the intended teacher.";
              })
              .catch(() => {
                link.input.select();
                status.textContent = "Select and copy the private link above.";
              });
          }),
          el(
            "p",
            "teacher-muted",
            `Expires ${new Date(expiry).toLocaleString()}. A new link replaces the previous one for this username.`,
          ),
        );
        status.textContent =
          response.emailStatus === "accepted"
            ? "The email service accepted this invitation. Ask the teacher to check their inbox and spam folder."
            : response.emailStatus === "failed"
              ? "Email sending failed. The private link is valid; you can share it securely instead."
              : "Private link created. Share it securely with the intended teacher.";
      } catch (error) {
        status.textContent =
          error instanceof Error ? error.message : "The invitation failed.";
      } finally {
        setBusy(false);
      }
    })();
  };
  return section;
}

export async function showActivation(
  root: HTMLElement,
  token: string,
  onComplete: (username: string) => void,
) {
  const main = el("main", "teacher-shell");
  const card = el("section", "teacher-card teacher-login");
  const status = el("p", "teacher-status", "Checking your private link…");
  status.role = "status";
  main.append(card, status);
  root.replaceChildren(main);
  try {
    const invitation = record(
      await request("/api/auth/activation/inspect", { token }),
    );
    const username = text(invitation.username, 64);
    const reset = invitation.kind === "reset";
    if (!reset && invitation.kind !== "invite")
      throw new Error("This invitation was invalid.");
    card.append(
      el("h1", "", reset ? "Choose a new password" : "Welcome to Sayboard"),
      el(
        "p",
        "",
        `Your teacher username is ${username}. Choose a password with at least 16 characters. A few unrelated words work well.`,
      ),
    );
    const form = el("form", "teacher-form");
    const password = field("New password", "password");
    password.input.autocomplete = "new-password";
    password.input.required = true;
    password.input.minLength = 16;
    password.input.maxLength = 256;
    const repeat = field("Confirm new password", "password");
    repeat.input.autocomplete = "new-password";
    repeat.input.required = true;
    const submit = el(
      "button",
      "button primary",
      reset ? "Save new password" : "Accept invitation",
    );
    submit.type = "submit";
    form.append(password.label, repeat.label, submit);
    card.append(form);
    status.textContent = `This ${reset ? "reset link" : "invitation"} expires ${new Date(integer(invitation.expiresAt)).toLocaleString()}.`;
    form.onsubmit = (event) => {
      event.preventDefault();
      if (password.input.value !== repeat.input.value) {
        status.textContent = "The passwords do not match.";
        repeat.input.focus();
        return;
      }
      const secret = password.input.value;
      password.input.value = "";
      repeat.input.value = "";
      submit.disabled = true;
      void request("/api/auth/activation", { token, password: secret })
        .then(() => {
          card.replaceChildren(
            el("h1", "", "Your password is saved"),
            el("p", "", "Sign in to start setting up your classroom."),
            button(
              "Continue to sign in",
              () => onComplete(username),
              "button primary",
            ),
          );
          status.textContent =
            "This private link has been used and will no longer work.";
        })
        .catch((error: unknown) => {
          status.textContent =
            error instanceof Error ? error.message : "Password setup failed.";
          submit.disabled = false;
        });
    };
  } catch (error) {
    card.append(
      el("h1", "", "This link is unavailable"),
      el(
        "p",
        "",
        "Ask your pilot organiser for a new invitation or password reset link.",
      ),
    );
    status.textContent =
      error instanceof Error
        ? error.message
        : "The invitation could not be opened.";
  }
}
