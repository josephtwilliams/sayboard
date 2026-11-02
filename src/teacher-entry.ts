import { accountClient, type RecoveryKit } from "./account";
import { createElement as el, createButton as button } from "./dom";

export type TeacherEntryState =
  | { kind: "signin" }
  | { kind: "register" }
  | { kind: "recover" }
  | { kind: "replace" }
  | { kind: "kit"; kit: RecoveryKit };

export function teacherEntry(
  state: Exclude<TeacherEntryState, { kind: "signin" }>,
  run: (work: () => Promise<void>) => void,
  showKit: (kit: RecoveryKit) => void,
  finish: () => Promise<void>,
  cancel: () => void,
): HTMLElement {
  const card = el("section", "teacher-card teacher-login");
  if (state.kind === "kit") {
    const kit = state.kit;
    card.append(
      el("h1", "", "Save your recovery kit"),
      el("p", "", `Teacher username: ${kit.username}`),
      el(
        "p",
        "",
        "Keep this code somewhere private, such as your password manager. It lets you choose a new password. Each recovery replaces the code.",
      ),
      el(
        "p",
        "",
        "If you lose both your password and this code, you will need help from the host administrator.",
      ),
    );
    const label = el("label", "", "Recovery code");
    const code = el("textarea", "teacher-recovery-code");
    code.readOnly = true;
    code.rows = 3;
    code.value = kit.recoveryCode;
    code.spellcheck = false;
    code.onclick = () => code.select();
    label.append(code);
    const copyStatus = el("p");
    copyStatus.role = "status";
    const copy = button("Copy recovery code", () => {
      void (async () => {
        try {
          await navigator.clipboard.writeText(kit.recoveryCode);
          copyStatus.textContent = "Recovery code copied.";
        } catch {
          code.focus();
          code.select();
          copyStatus.textContent =
            "Copy is unavailable. Copy the selected code or download the kit.";
        }
      })();
    });
    const download = button("Download recovery kit", () => {
      const url = URL.createObjectURL(
        new Blob(
          [
            `Sayboard recovery kit\nWebsite: ${location.origin}\nTeacher username: ${kit.username}\nRecovery code: ${kit.recoveryCode}\nKeep this private. Each recovery replaces this code.\n`,
          ],
          { type: "text/plain" },
        ),
      );
      const link = el("a");
      link.href = url;
      link.download = "sayboard-recovery-kit.txt";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    card.append(
      label,
      copy,
      download,
      copyStatus,
      button("I saved my recovery kit", () => run(finish), "button primary"),
    );
    return card;
  }
  const replacing = state.kind === "replace";
  const recovering = state.kind === "recover";
  card.append(
    el(
      "h1",
      "",
      replacing
        ? "Replace recovery code"
        : recovering
          ? "Recover your workspace"
          : "Create teacher workspace",
    ),
  );
  card.append(
    el(
      "p",
      "",
      replacing
        ? "Confirm your current password to replace your recovery code. Your previous code will stop working."
        : recovering
          ? "Use your recovery kit to choose a new password. Your classrooms and linked learner devices stay in place."
          : "Choose a username and a password of at least 16 characters. No student details or email address are needed.",
    ),
  );
  const form = el("form", "teacher-form");
  const field = (
    labelText: string,
    type: string,
    autocomplete: HTMLInputElement["autocomplete"],
    maxLength: number,
  ) => {
    const label = el("label", "", labelText);
    const input = el("input");
    input.type = type;
    input.autocomplete = autocomplete;
    input.required = true;
    input.maxLength = maxLength;
    input.autocapitalize = "none";
    input.spellcheck = false;
    label.append(input);
    form.append(label);
    return input;
  };
  const username = replacing
    ? null
    : field("Teacher username", "text", "username", 64);
  if (username) username.pattern = "[a-zA-Z0-9_-]{1,64}";
  const recoveryCode = recovering
    ? field("Recovery code", "text", "off", 64)
    : null;
  const password = field(
    replacing ? "Current password" : "New password",
    "password",
    replacing ? "current-password" : "new-password",
    256,
  );
  password.minLength = 16;
  const submit = el(
    "button",
    "button primary",
    replacing
      ? "Replace recovery code"
      : recovering
        ? "Recover workspace"
        : "Create workspace",
  );
  submit.type = "submit";
  form.append(submit, button("Cancel", cancel));
  form.onsubmit = (event) => {
    event.preventDefault();
    const name = username?.value.trim() ?? "";
    const secret = password.value;
    const code = recoveryCode?.value.trim() ?? "";
    password.value = "";
    if (recoveryCode) recoveryCode.value = "";
    run(async () => {
      const kit = replacing
        ? await accountClient.replaceRecoveryKit(secret)
        : await accountClient.enterWorkspace(
            recovering
              ? {
                  kind: "recover",
                  username: name,
                  password: secret,
                  recoveryCode: code,
                }
              : { kind: "register", username: name, password: secret },
          );
      showKit(kit);
    });
  };
  card.append(form);
  return card;
}
