import { createElement as el, createButton as button } from "./dom";
import { deviceClient } from "./classroom-client";
import { type createClassroomSync, type SyncState } from "./classroom-sync";

export function createClassroomPanel({
  sync,
  confirm,
  setPending,
}: {
  sync: ReturnType<typeof createClassroomSync>;
  confirm: (message: string) => Promise<boolean>;
  setPending: (pending: boolean) => void;
}) {
  const section = el("section", "settings account-panel");
  const content = el("div");
  const notice = el("p", "notice");
  notice.role = "status";
  section.append(el("h2", "", "Classroom board"), content, notice);
  let busy = false;
  async function perform(run: () => Promise<void>) {
    if (busy) return;
    busy = true;
    setPending(true);
    section
      .querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")
      .forEach((control) => (control.disabled = true));
    try {
      await run();
    } catch (error) {
      notice.textContent =
        error instanceof Error
          ? error.message
          : "Could not reach the classroom.";
    } finally {
      busy = false;
      setPending(false);
      if (section.isConnected) render(sync.state());
    }
  }
  function render(state: SyncState) {
    content.replaceChildren();
    if (state.kind === "unlinked") {
      content.append(
        el(
          "p",
          "",
          "Link this browser once. Your teacher’s published boards will then update automatically.",
        ),
      );
      const form = el("form", "account-login");
      const label = el("label", "", "Classroom pairing code");
      const code = el("input");
      code.required = true;
      code.maxLength = 20;
      code.autocomplete = "off";
      code.autocapitalize = "characters";
      label.append(code);
      const pair = el("button", "button primary", "Link classroom device");
      pair.type = "submit";
      form.append(label, pair);
      form.onsubmit = (event) => {
        event.preventDefault();
        const value = code.value;
        void perform(async () => {
          if (
            !(await confirm(
              "Link this browser to your teacher’s board and enable automatic updates? Once you return to the communication board, published versions will be saved and applied automatically. Updates wait while someone is speaking, typing or editing.",
            )) ||
            !section.isConnected
          )
            return;
          await deviceClient.pair(value);
          const remote = await deviceClient.sync();
          sync.connect(remote);
          code.value = "";
        });
      };
      content.append(form);
      notice.textContent ||=
        "Your current board stays here until you link a classroom.";
    } else {
      content.append(
        el("p", "", `Linked to ${state.label}. Updates are automatic.`),
      );
      const messages = {
        checking: "Checking the classroom connection…",
        current: `Version ${state.version} saved on this device. Future publications will arrive automatically.`,
        waiting: state.publishedVersion
          ? `Version ${state.publishedVersion} is ready. Return to the communication board; it will update after speaking, typing or editing finishes.`
          : "Waiting for your teacher’s first publication. Your current board stays available.",
        offline:
          "Could not reach the classroom. This device keeps its saved board and will try again automatically.",
        "storage-error":
          "This browser could not save the update. Its current board is kept. Free some browser storage; Sayboard will try again automatically.",
      };
      notice.textContent = messages[state.status];
      content.append(
        button(
          "Disconnect classroom device",
          () =>
            void perform(async () => {
              if (
                !(await confirm(
                  "Stop automatic classroom updates to this browser? Its saved working board will stay here.",
                ))
              )
                return;
              const remote = await deviceClient.sync();
              await deviceClient.unlink(remote.csrfToken);
              sync.disconnect();
              notice.textContent =
                "Disconnected. Your saved board stays on this device.";
            }),
        ),
      );
    }
    const dashboard = el("a", "button", "Teacher dashboard");
    dashboard.href = [
      "sayboard.org",
      "www.sayboard.org",
      "sayboard.vercel.app",
    ].includes(location.hostname)
      ? "https://classroom.sayboard.org/teacher"
      : "/teacher";
    content.append(dashboard);
    if (busy)
      section
        .querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")
        .forEach((control) => (control.disabled = true));
  }
  const dispose = sync.subscribe((state) => {
    if (section.isConnected && !busy) render(state);
  });
  render(sync.state());
  return { element: section, dispose };
}
