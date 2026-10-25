import { createTeacherWorkspace } from "./teacher-workspace";
import {
  parseTeacherLocation,
  teacherHref,
  type WorkspaceSection,
} from "./teacher-navigation";
import { createElement as el, createButton as button } from "./dom";
import { renderSymbol } from "./symbols";
import { accountClient, AccountError } from "./account";
import { teacherClient, ClassroomError } from "./classroom-client";
import {
  type Classroom,
  type ClassroomDetail,
  type ProfileDetail,
} from "./classroom-contract";
import { serializeBoard, type Board } from "./board";
import { pendingTeacherDemo, clearTeacherDemoIntent } from "./teacher-demo";
import "./style.css";
import "./teacher.css";
import {
  canInvite,
  createInvitationsPanel,
  showActivation,
} from "./teacher-invitations";
import { mountGoogleSignIn, googleSignInNotice } from "./google-signin";

const root = document.querySelector<HTMLDivElement>("#teacher-app");
if (!root) throw new Error("Missing teacher workspace");
let signedIn = false;
let serviceDisabled = false;
let operator = false;
let busy = false;
let rooms: Classroom[] = [];
let room: ClassroomDetail | null = null;
let profile: ProfileDetail | null = null;
let notice = "Checking the classroom service…";
let errorNotice = false;
let pairing: { code: string; expiresAt: number } | null = null;
const fieldValues = new Map<string, string>();
let deviceStatusContainer: HTMLElement | null = null;
let refreshingDevices = false;
let nextFocus = "";
let workspaceSection: WorkspaceSection = "board";
let activeActionURL: string | null = null;
let routeRequest = 0;
let requestedLocation = "";
let exampleBoard: Board | null = null;
try {
  exampleBoard = pendingTeacherDemo(sessionStorage);
} catch {
  // A blocked tab store never falls back to the learner's device board.
}
function consumedExample() {
  exampleBoard = null;
  try {
    clearTeacherDemoIntent(sessionStorage);
  } catch {
    // Saving a board has already succeeded; tab storage is optional.
  }
}
function textField(key: string, labelText: string, placeholder = "") {
  const label = el("label", "", labelText);
  const input = el("input");
  input.required = true;
  input.maxLength = 100;
  input.value = fieldValues.get(key) ?? "";
  input.placeholder = placeholder;
  input.oninput = () => fieldValues.set(key, input.value);
  label.append(input);
  return { label, input };
}
function firstBoardForm() {
  const setup = el("form", "teacher-form teacher-first-board");
  const classroom = textField(
    "first-classroom",
    "Classroom name",
    "My classroom",
  );
  const learner = textField("first-learner", "Learner alias", "Learner A");
  const submit = el("button", "button primary", "Create first board");
  submit.type = "submit";
  setup.append(
    classroom.label,
    learner.label,
    el(
      "p",
      "teacher-muted",
      "Use an alias instead of a learner's full name. Learners need no email or account.",
    ),
    submit,
  );
  setup.onsubmit = (event) => {
    event.preventDefault();
    const name = classroom.input.value.trim();
    const alias = learner.input.value.trim();
    if (!name || !alias) return;
    void perform(async () => {
      const created = await teacherClient.create(name);
      rooms = [...rooms, created];
      room = { ...created, profiles: [] };
      profile = null;
      pairing = null;
      rememberLocation();
      // Keep a recoverable classroom if learner creation fails; retrying from
      // that classroom must not create another empty classroom.
      fieldValues.set("profile", alias);
      profile = await teacherClient.addProfile(
        created.id,
        alias,
        exampleBoard ?? undefined,
      );
      room = await teacherClient.classroom(created.id);
      consumedExample();
      fieldValues.delete("first-classroom");
      fieldValues.delete("first-learner");
      fieldValues.delete("profile");
      rememberLocation();
      notice =
        "Your first board is ready. Try it, or edit the words for your learner.";
    });
  };
  return setup;
}
function exampleForExistingClassroom() {
  const card = el("section", "teacher-card teacher-first-board-card");
  const save = el("form", "teacher-form");
  const label = el("label", "", "Save in classroom");
  const select = el("select");
  select.id = "teacher-example-classroom";
  label.htmlFor = select.id;
  for (const value of rooms) select.append(new Option(value.name, value.id));
  const alias = textField("example-learner", "Learner alias", "Learner A");
  const submit = el(
    "button",
    "button primary",
    "Save example as a new learner board",
  );
  submit.type = "submit";
  save.append(label, select, alias.label, submit);
  save.onsubmit = (event) => {
    event.preventDefault();
    const classroom = rooms.find((value) => value.id === select.value);
    const name = alias.input.value.trim();
    if (!classroom || !name || !exampleBoard) return;
    void perform(async () => {
      profile = await teacherClient.addProfile(
        classroom.id,
        name,
        exampleBoard ?? undefined,
      );
      room = await teacherClient.classroom(classroom.id);
      consumedExample();
      fieldValues.delete("example-learner");
      rememberLocation();
      notice =
        "Example saved as a private classroom draft. Try it before publishing.";
    });
  };
  card.append(
    el("h2", "", "Keep the board you tried"),
    el(
      "p",
      "",
      "Create a new learner board from the example in this tab. Saving sends that board to your teacher workspace.",
    ),
    save,
  );
  return card;
}

function lastContact(timestamp: number | null) {
  if (timestamp === null) return "No contact reported yet";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "Last contact just now";
  if (seconds < 60) return `Last contact ${seconds} seconds ago`;
  return `Last contact ${new Date(timestamp).toLocaleString()}`;
}
function renderDevices(container: HTMLElement, current: ProfileDetail) {
  container.replaceChildren();
  const count = root?.querySelector("[data-device-count]");
  if (count)
    count.textContent = current.devices.length
      ? `${current.devices.length} linked device${current.devices.length === 1 ? "" : "s"}`
      : "No devices linked yet";
  const summary = el("p", "teacher-muted teacher-device-summary");
  summary.textContent = current.devices.length
    ? "Device reports refresh automatically. Updates wait while a learner is speaking, typing or using caregiver controls."
    : "No devices linked yet. Pair a learner’s device once to start automatic updates.";
  container.append(summary);
  for (const device of current.devices) {
    const row = el("div", "teacher-row teacher-device-row");
    const details = el("div", "teacher-device-details");
    const recent =
      device.lastSeenAt !== null && Date.now() - device.lastSeenAt < 30_000;
    const applied =
      current.publishedVersion > 0 &&
      device.appliedVersion === current.publishedVersion;
    const state =
      device.expiresAt <= Date.now()
        ? "Link expired. Pair this device again."
        : applied
          ? `Version ${device.appliedVersion} saved${recent ? ". Up to date" : ""}`
          : current.publishedVersion
            ? `Waiting for version ${current.publishedVersion}${device.appliedVersion ? `. Version ${device.appliedVersion} saved` : ""}`
            : "Waiting for the first publication";
    details.append(
      el("strong", "", device.name),
      el(
        "span",
        `teacher-device-state${applied && recent ? " current" : ""}`,
        state,
      ),
      el(
        "span",
        "teacher-muted",
        `${lastContact(device.lastSeenAt)}${device.lastSeenAt !== null && !recent ? ". No recent contact" : ""}`,
      ),
    );
    row.append(
      details,
      action("Revoke " + device.name, async () => {
        if (
          !(await confirm(
            `Stop future updates to ${device.name}? Its saved board stays available.`,
          ))
        )
          return;
        await teacherClient.revoke(current.id, device.id);
        await refreshProfile();
        notice = "Device access revoked. Its saved board remains available.";
      }),
    );
    container.append(row);
  }
}
async function refreshDeviceReports() {
  const current = profile;
  const container = deviceStatusContainer;
  if (
    !signedIn ||
    !current ||
    !container ||
    busy ||
    refreshingDevices ||
    document.visibilityState !== "visible"
  )
    return;
  // Updating only the receipt list preserves form values, focus, and a live pairing code.
  if (
    container.contains(document.activeElement) ||
    document.querySelector("dialog[open]")
  )
    return;
  refreshingDevices = true;
  try {
    const latest = await teacherClient.profile(current.id);
    if (
      !signedIn ||
      profile?.id !== current.id ||
      container !== deviceStatusContainer ||
      busy ||
      container.contains(document.activeElement) ||
      document.querySelector("dialog[open]")
    )
      return;
    profile = { ...profile, devices: latest.devices };
    renderDevices(container, latest);
  } catch (error) {
    if (profile?.id !== current.id || container !== deviceStatusContainer)
      return;
    if (
      (error instanceof ClassroomError || error instanceof AccountError) &&
      [401, 403].includes(error.status)
    ) {
      clearPrivateView();
      notice =
        "Your teacher session ended. Sign in again to see device reports.";
      errorNotice = true;
      render();
    } else {
      const summary = container.querySelector(".teacher-device-summary");
      if (summary)
        summary.textContent =
          "Device reports could not refresh. The reports below show the last known state. Saved learner boards remain available.";
    }
  } finally {
    refreshingDevices = false;
  }
}

function link(label: string, href: string, className = "button") {
  const a = el("a", className, label);
  a.href = href;
  return a;
}
async function confirm(message: string): Promise<boolean> {
  const dialog = el("dialog", "teacher-dialog");
  const heading = el("h2", "", "Confirm classroom change");
  heading.id = "teacher-confirmation";
  dialog.setAttribute("aria-labelledby", heading.id);
  let approved = false;
  dialog.append(
    heading,
    el("p", "", message),
    button("Cancel", () => dialog.close()),
    button(
      "Confirm",
      () => {
        approved = true;
        dialog.close();
      },
      "button primary",
    ),
  );
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.onclose = () => {
      dialog.remove();
      resolve(approved);
    };
    dialog.showModal();
  });
}
function action(label: string, run: () => Promise<void>, primary = false) {
  return button(
    label,
    () => void perform(run),
    primary ? "button primary" : "button",
  );
}
async function perform(run: () => Promise<void>) {
  if (busy) return;
  busy = true;
  const startingURL = location.href;
  activeActionURL = startingURL;
  const scrollPosition = window.scrollY;
  const focused = document.activeElement;
  const focusedLabel =
    focused instanceof HTMLElement ? focused.textContent : null;
  root
    ?.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")
    .forEach((control) => (control.disabled = true));
  try {
    await run();
    errorNotice = false;
  } catch (error) {
    notice =
      error instanceof Error ? error.message : "The classroom request failed.";
    errorNotice = true;
    if (
      (error instanceof ClassroomError || error instanceof AccountError) &&
      [401, 403].includes(error.status)
    )
      clearPrivateView();
  } finally {
    busy = false;
    activeActionURL = null;
    if (
      requestedLocation &&
      requestedLocation !== startingURL &&
      location.href === requestedLocation
    ) {
      await restoreWorkspaceLocation();
      return;
    }
    const navigated = location.href !== startingURL;
    render();
    const target = errorNotice
      ? root?.querySelector<HTMLElement>(".teacher-status")
      : navigated
        ? root?.querySelector<HTMLElement>("h1")
        : nextFocus
          ? root?.querySelector<HTMLElement>(nextFocus)
          : Array.from(
              root?.querySelectorAll<HTMLButtonElement>("button") ?? [],
            ).find(
              (node) => node.textContent === focusedLabel && !node.disabled,
            );
    if (target) {
      if (target.tagName !== "BUTTON" && target.tagName !== "INPUT")
        target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
    window.scrollTo({
      top: navigated ? 0 : scrollPosition,
      behavior: "instant",
    });
    nextFocus = "";
  }
}

function clearPrivateView() {
  signedIn = false;
  operator = false;
  rooms = [];
  room = null;
  profile = null;
  pairing = null;
  workspaceSection = "board";
  requestedLocation = "";
  routeRequest++;
  fieldValues.clear();
  history.replaceState(null, "", location.pathname);
}
function rememberLocation(replace = false) {
  if (activeActionURL && location.href !== activeActionURL) return;
  const destination = teacherHref(
    room
      ? profile
        ? {
            kind: "learner",
            classroomId: room.id,
            profileId: profile.id,
            section: workspaceSection,
          }
        : { kind: "classroom", classroomId: room.id }
      : { kind: "classrooms" },
  );
  if (location.pathname + location.hash === destination) return;
  if (replace) history.replaceState(null, "", destination);
  else history.pushState(null, "", destination);
  if (activeActionURL) activeActionURL = location.href;
}
async function restoreWorkspaceLocation() {
  if (!signedIn) return;
  const destination = location.href;
  requestedLocation = destination;
  const ticket = ++routeRequest;
  const route = parseTeacherLocation(location.hash);
  if (!route) {
    notice =
      "This classroom address is invalid. Choose a classroom from the workspace.";
    errorNotice = true;
    render();
    return;
  }
  const nextRoom =
    route.kind === "classrooms"
      ? null
      : await teacherClient.classroom(route.classroomId);
  const nextProfile =
    route.kind === "learner" &&
    nextRoom?.profiles.some((value) => value.id === route.profileId)
      ? await teacherClient.profile(route.profileId)
      : null;
  if (ticket !== routeRequest || location.href !== destination) return;
  room = nextRoom;
  profile = nextProfile;
  workspaceSection = route.kind === "learner" ? route.section : "board";
  pairing = null;
  if (!busy) {
    render();
    const heading = root?.querySelector<HTMLElement>("h1");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  }
}

function form(
  key: string,
  labelText: string,
  submitText: string,
  run: (value: string) => Promise<void>,
) {
  const form = el("form", "teacher-form");
  const label = el("label", "", labelText);
  const input = el("input");
  input.id = "teacher-" + key;
  input.required = true;
  input.maxLength = key === "device" ? 60 : 100;
  input.value = fieldValues.get(key) ?? "";
  input.oninput = () => fieldValues.set(key, input.value);
  label.append(input);
  const submit = el("button", "button primary", submitText);
  submit.type = "submit";
  form.append(label, submit);
  form.onsubmit = (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    void perform(async () => {
      await run(value);
      fieldValues.delete(key);
    });
  };
  return form;
}
async function loadRoom(value: Classroom) {
  room = await teacherClient.classroom(value.id);
  profile = null;
  pairing = null;
  workspaceSection = "board";
  rememberLocation();
  notice = "Choose a profile or add one below.";
}
async function refreshProfile() {
  if (!profile || !room) return;
  profile = await teacherClient.profile(profile.id);
  room = await teacherClient.classroom(room.id);
  pairing = null;
}
function exportProfile(value: ProfileDetail) {
  const url = URL.createObjectURL(
    new Blob([serializeBoard(value.board)], { type: "application/json" }),
  );
  const a = link("", url);
  a.download = `sayboard-${value.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function render() {
  if (!root) return;
  deviceStatusContainer = null;
  root.replaceChildren();
  const shell = el("main", "teacher-shell");
  const header = el("header", "teacher-header");
  const brand = el("div", "brand");
  brand.append(renderSymbol("message-circle"), el("span", "", "sayboard"));
  const navigation = el("nav", "teacher-actions");
  navigation.setAttribute("aria-label", "Teacher navigation");
  navigation.append(link("Open communication board", "/"));
  if (signedIn)
    navigation.append(
      el(
        "span",
        "teacher-user",
        accountClient.currentSession()?.account.username ?? "",
      ),
      action("Sign out", async () => {
        await accountClient.logout();
        consumedExample();
        clearPrivateView();
        notice = "Signed out.";
      }),
    );
  header.append(brand, navigation);
  shell.append(header);
  const status = el(
    "p",
    `teacher-status${errorNotice ? " error" : ""}`,
    notice,
  );
  status.role = "status";
  status.setAttribute("aria-live", "polite");
  if (!signedIn) {
    shell.append(
      el("h1", "", "A familiar board for every learner."),
      el(
        "p",
        "teacher-intro",
        "Prepare a board, link each learner’s device once, then publish updates from here. Linked devices update automatically and keep their saved board when disconnected.",
      ),
    );
    const card = el("section", "teacher-card teacher-login");
    card.append(
      el("h2", "", "Teacher sign in"),
      el(
        "p",
        "",
        "The teacher pilot is invite-only. Open your invitation to choose a password, or sign in with your existing account.",
      ),
    );
    const login = el("form", "teacher-form");
    if (!serviceDisabled) mountGoogleSignIn(card);
    const usernameLabel = el("label", "", "Teacher username");
    const username = el("input");
    username.autocomplete = "username";
    username.required = true;
    username.maxLength = 64;
    username.autocapitalize = "none";
    username.spellcheck = false;
    username.value = fieldValues.get("login-username") ?? "";
    usernameLabel.append(username);
    const passwordLabel = el("label", "", "Password");
    const password = el("input");
    password.type = "password";
    password.autocomplete = "current-password";
    password.required = true;
    passwordLabel.append(password);
    const submit = el("button", "button primary", "Sign in");
    submit.type = "submit";
    login.append(usernameLabel, passwordLabel, submit);
    login.onsubmit = (event) => {
      event.preventDefault();
      const secret = password.value;
      const name = username.value.trim();
      password.value = "";
      void perform(async () => {
        await accountClient.login(name, secret);
        clearPrivateView();
        rooms = await teacherClient.list();
        operator = await canInvite();
        signedIn = true;
        notice = "Signed in. Choose a classroom or create your first one.";
      });
    };
    card.append(
      ...(serviceDisabled ? [] : [login]),
      el(
        "p",
        "teacher-muted",
        "Need a password reset? Contact your Sayboard administrator. Student accounts and email addresses are not required.",
      ),
    );
    const welcome = el("section", "teacher-card teacher-welcome");
    welcome.append(
      el("h2", "", "Try a board before you sign up"),
      el(
        "p",
        "",
        "Hear the words, change a few tiles, and see what could work for your learner. No account or student details needed.",
      ),
      link("Try a board", "/?teacherDemo=1", "button primary"),
      el(
        "p",
        "teacher-muted",
        "Your example stays in this tab. Your saved device board is unchanged.",
      ),
    );
    const entry = el("div", "teacher-entry-grid");
    entry.append(welcome, card);
    shell.append(entry, status);
  } else if (!room) {
    shell.append(
      el("h1", "", "Your classrooms"),
      el(
        "p",
        "teacher-intro",
        "Keep each learner’s draft, published versions and linked devices together.",
      ),
      status,
    );
    const grid = el("div", "teacher-grid");
    for (const value of rooms) {
      const card = el("section", "teacher-card");
      card.append(
        el("h2", "", value.name),
        action("Open " + value.name, () => loadRoom(value), true),
      );
      grid.append(card);
    }
    if (!rooms.length) {
      const create = el("section", "teacher-card teacher-first-board-card");
      create.append(
        el("h2", "", "Your first classroom, step by step"),
        el(
          "p",
          "",
          exampleBoard
            ? "Keep the board you just tried. Create a classroom and learner alias to save your example as a private draft on this server."
            : "Give your classroom a name and add one learner alias. We'll start a board you can try and change.",
        ),
        firstBoardForm(),
      );
      grid.append(create);
    } else {
      const create = el("section", "teacher-card");
      create.append(
        el("h2", "", "Create a classroom"),
        form(
          "classroom",
          "Classroom name",
          "Create classroom",
          async (name) => {
            const created = await teacherClient.create(name);
            rooms = await teacherClient.list();
            await loadRoom(created);
          },
        ),
      );
      grid.append(create);
    }
    if (exampleBoard && rooms.length)
      shell.append(exampleForExistingClassroom());
    shell.append(grid);
    if (operator) shell.append(createInvitationsPanel());
  } else if (!profile) {
    const current = room;
    shell.append(
      el("h1", "", current.name),
      el(
        "p",
        "teacher-intro",
        "Use classroom aliases for profiles. Avoid full student names or other unnecessary personal information.",
      ),
      status,
    );
    const grid = el("div", "teacher-grid");
    for (const value of current.profiles) {
      const card = el("section", "teacher-card");
      card.append(
        el("h2", "", value.label),
        el(
          "p",
          "teacher-muted",
          value.publishedVersion
            ? `Published version ${value.publishedVersion}`
            : "Draft only. Not yet published.",
        ),
        action(
          "Manage " + value.label,
          async () => {
            profile = await teacherClient.profile(value.id);
            pairing = null;
            workspaceSection = "board";
            rememberLocation();
            notice = "Edit the draft, then publish when it is ready.";
          },
          true,
        ),
      );
      grid.append(card);
    }
    const add = el("section", "teacher-card");
    add.append(
      el("h2", "", "Add a learner profile"),
      el(
        "p",
        "",
        exampleBoard
          ? "Your example is still in this tab. Add the learner to save that example as a private classroom draft."
          : "Each profile starts with the starter board. Edit it or import an existing Sayboard file.",
      ),
      form("profile", "Profile alias", "Add profile", async (label) => {
        profile = await teacherClient.addProfile(
          current.id,
          label,
          exampleBoard ?? undefined,
        );
        consumedExample();
        room = await teacherClient.classroom(current.id);
        rememberLocation();
        notice =
          "Profile created. Its board is a private draft until published.";
      }),
    );
    grid.append(add);
    shell.append(grid);
    const remove = el("section", "teacher-danger");
    remove.append(
      action("Delete classroom", async () => {
        if (
          !(await confirm(
            `Permanently delete ${current.name}, all its profiles, saved versions and device links? Working device boards remain on their devices. Export any boards you need first.`,
          ))
        )
          return;
        await teacherClient.removeClassroom(current.id);
        rooms = await teacherClient.list();
        room = null;
        rememberLocation();
        notice = "Classroom deleted.";
      }),
    );
    shell.append(remove);
  } else {
    const current = profile;
    const classroom = room;
    shell.append(
      el("h1", "", current.label),
      el(
        "p",
        "teacher-intro",
        "A board that grows with your learner. Edit the draft, preview it, then publish when you’re ready.",
      ),
      status,
    );
    const grid = el("div", "teacher-profile-grid");
    const draft = el("section", "teacher-card teacher-draft");
    const homeTiles = current.board.tiles.filter(Boolean).length;
    draft.append(
      el("h2", "", "Draft board"),
      el(
        "p",
        "",
        `${homeTiles} home ${homeTiles === 1 ? "tile" : "tiles"}, ${current.board.subBoards.length} ${current.board.subBoards.length === 1 ? "category" : "categories"}. Draft revision ${current.revision}`,
      ),
    );
    const actions = el("div", "teacher-actions");
    const editor = `/?teacherBoard=${current.id}&classroom=${classroom.id}`;
    actions.append(
      link("Edit board", editor),
      link("Preview board", editor + "&preview=1"),
    );
    const boardPreview = el("div", "teacher-board-preview");
    boardPreview.setAttribute("aria-label", "Saved draft vocabulary preview");
    for (const tile of current.board.tiles.slice(0, 10)) {
      const previewTile = el(
        "div",
        tile
          ? `teacher-preview-tile ${tile.tone}`
          : "teacher-preview-tile empty",
      );
      if (tile)
        previewTile.append(renderSymbol(tile.icon), el("span", "", tile.label));
      else previewTile.setAttribute("aria-label", "Empty slot");
      boardPreview.append(previewTile);
    }
    draft.append(boardPreview, actions);
    const duplicate = el("details", "teacher-secondary-tools");
    duplicate.append(
      el("summary", "", "Copy this board for another learner"),
      form(
        "duplicate",
        "New profile alias",
        "Duplicate this board",
        async (label) => {
          profile = await teacherClient.addProfile(
            classroom.id,
            label,
            current.board,
          );
          room = await teacherClient.classroom(classroom.id);
          pairing = null;
          rememberLocation();
          notice =
            "Board copied to a new profile draft. Device links were not copied.";
        },
      ),
    );
    const tools = el("details", "teacher-secondary-tools");
    tools.append(
      el("summary", "", "More board options"),
      button("Export draft", () => exportProfile(current)),
      action("Refresh saved draft", async () => {
        await refreshProfile();
        notice = "Saved draft refreshed.";
      }),
      duplicate,
    );
    draft.append(tools);
    grid.append(draft);
    const publish = el("section", "teacher-card teacher-publication");
    publish.append(
      el(
        "h2",
        "",
        current.publishedVersion
          ? `Published version ${current.publishedVersion}`
          : "Ready to publish",
      ),
      el(
        "p",
        "",
        "Publish the saved draft to linked devices. Each learner keeps their current board until they finish speaking or editing.",
      ),
      action(
        "Publish saved draft",
        async () => {
          if (
            !(await confirm(
              `Publish the saved draft for ${current.label}? Linked devices will update automatically after speech, typing and caregiver editing finish.`,
            ))
          )
            return;
          profile = await teacherClient.publish(current.id, current.revision);
          room = await teacherClient.classroom(classroom.id);
          notice = profile.devices.length
            ? `Version ${profile.publishedVersion} published. Linked devices update automatically. Check their reports below to confirm receipt.`
            : "Board published. Open Devices when you are ready to connect a learner’s device.";
        },
        true,
      ),
    );
    grid.append(publish);
    const devices = el("section", "teacher-card teacher-devices");
    devices.append(
      el("h2", "", "Connected devices"),
      el(
        "p",
        "",
        "Link once. Future board updates arrive automatically, when the learner is ready.",
      ),
    );
    const reports = el("div", "teacher-device-reports");
    deviceStatusContainer = reports;
    renderDevices(reports, current);
    devices.append(reports);
    const setup = el("details", "teacher-device-setup");
    setup.id = "teacher-device-setup";
    setup.open = !current.devices.length || pairing !== null;
    setup.append(
      el("summary", "", "Link a learner device"),
      el("ol", "teacher-device-instructions", ""),
      form("device", "Device name", "Create pairing code", async (name) => {
        pairing = await teacherClient.pairing(current.id, name);
        notice =
          "Enter this code on the intended device within ten minutes and confirm the initial connection. Future publications sync automatically. Creating another code replaces this one.";
      }),
    );
    const instructions = setup.querySelector("ol");
    for (const instruction of [
      "Open the address below on the learner's device. It opens the connection screen directly.",
      "Enter the code below and choose Link classroom device.",
      "Confirm the connection, then choose Back to board. Your learner's board will arrive when communication is idle.",
    ])
      instructions?.append(el("li", "", instruction));
    const address = el(
      "label",
      "teacher-link-field",
      "Open this address on the learner’s device",
    );
    const addressInput = el("input");
    addressInput.readOnly = true;
    addressInput.value = location.origin + "/?linkClassroom=1";
    addressInput.onclick = () => addressInput.select();
    address.append(addressInput);
    setup.insertBefore(address, setup.querySelector("form"));
    if (pairing) {
      const panel = el("div", "teacher-pairing");
      panel.append(
        el("p", "", "Single-use pairing code"),
        el("code", "", pairing.code),
        el(
          "p",
          "teacher-muted",
          `Expires ${new Date(pairing.expiresAt).toLocaleTimeString()}. Refreshing this page hides the code.`,
        ),
      );
      setup.append(panel);
      setup.append(
        action("Copy pairing code", async () => {
          if (!pairing) return;
          try {
            await navigator.clipboard.writeText(pairing.code);
            notice = "Pairing code copied. Enter it on the intended device.";
          } catch {
            notice = "Select and copy the code shown above.";
          }
        }),
      );
    }
    devices.append(setup);
    grid.append(devices);
    const versions = el("details", "teacher-card teacher-versions");
    versions.append(
      el("summary", "", "Published versions"),
      el(
        "p",
        "teacher-muted",
        "Restore an earlier version to your draft. Preview and publish it when you’re ready.",
      ),
    );
    if (!current.versions.length)
      versions.append(
        el(
          "p",
          "teacher-muted",
          "Your first published version will appear here.",
        ),
      );
    for (const version of current.versions) {
      const row = el("div", "teacher-row");
      row.append(
        el(
          "span",
          "",
          `Version ${version.number}, published ${new Date(version.createdAt).toLocaleString()}`,
        ),
        action("Restore version " + version.number + " to draft", async () => {
          if (
            !(await confirm(
              `Replace the saved draft with version ${version.number}? The currently published version stays unchanged until you publish this draft.`,
            ))
          )
            return;
          profile = await teacherClient.restore(
            current.id,
            current.revision,
            version.number,
          );
          notice = `Version ${version.number} restored into the draft. Preview it before publishing.`;
        }),
      );
      versions.append(row);
    }
    grid.append(versions);
    shell.append(grid);
    const remove = el("section", "teacher-danger");
    remove.append(
      action("Delete profile", async () => {
        if (
          !(await confirm(
            `Permanently delete ${current.label}, its versions and device links? Export the draft first if needed. Device boards stay on their devices.`,
          ))
        )
          return;
        await teacherClient.removeProfile(current.id);
        await loadRoom(classroom);
        notice = "Profile deleted.";
      }),
    );
    shell.append(remove);
  }
  shell.append(
    el(
      "footer",
      "teacher-footer",
      "Boards and published vocabulary are stored on this server. Spoken messages and speech history are not collected. The communication board remains available without a teacher session.",
    ),
  );
  if (signedIn) {
    const actions: Node[] = [];
    if (room && profile) {
      const preview = Array.from(
        shell.querySelectorAll<HTMLAnchorElement>(
          ".teacher-draft .teacher-actions a",
        ),
      ).find((node) => node.textContent === "Preview board");
      const publish = shell.querySelector<HTMLButtonElement>(
        ".teacher-publication button",
      );
      const save = button("Save classroom draft", () => {});
      save.disabled = true;
      if (preview) actions.push(preview);
      actions.push(save);
      if (publish) actions.push(publish);
      for (const panel of shell.querySelectorAll<HTMLElement>(
        ".teacher-draft,.teacher-publication,.teacher-devices,.teacher-versions",
      )) {
        panel.hidden = panel.classList.contains("teacher-devices")
          ? workspaceSection !== "devices"
          : panel.classList.contains("teacher-versions")
            ? workspaceSection !== "versions"
            : workspaceSection !== "board";
      }
      const versions =
        shell.querySelector<HTMLDetailsElement>(".teacher-versions");
      if (versions && workspaceSection === "versions") versions.open = true;
      const remove = shell.querySelector<HTMLElement>(".teacher-danger");
      if (remove) remove.hidden = workspaceSection !== "board";
      shell.querySelector(":scope > .teacher-intro")?.remove();
    }
    root.append(
      createTeacherWorkspace({
        content: shell,
        room,
        profile,
        section: workspaceSection,
        actions,
        feedback: status,
        title: shell.querySelector("h1")?.textContent ?? "Your classrooms",
      }),
    );
  } else root.append(shell);
  if (busy)
    root
      .querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")
      .forEach((control) => (control.disabled = true));
}
setInterval(() => void refreshDeviceReports(), 5000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshDeviceReports();
});
function handleLocationChange() {
  if (new URLSearchParams(location.hash.slice(1)).has("activate")) {
    location.reload();
    return;
  }
  if (requestedLocation === location.href) return;
  const destination = location.href;
  void restoreWorkspaceLocation().catch((error) => {
    if (location.href !== destination) return;
    notice =
      error instanceof Error
        ? error.message
        : "This classroom could not be opened.";
    errorNotice = true;
    if (error instanceof ClassroomError && [401, 403].includes(error.status))
      clearPrivateView();
    render();
  });
}
window.addEventListener("hashchange", handleLocationChange);
window.addEventListener("popstate", handleLocationChange);
const activation = new URLSearchParams(location.hash.slice(1)).get("activate");
const googleNotice = googleSignInNotice();
if (activation !== null) {
  history.replaceState(null, "", location.pathname);
  void showActivation(root, activation, (username) => {
    fieldValues.set("login-username", username);
    notice = "Password saved. Sign in to open your teacher workspace.";
    render();
  });
} else {
  render();
  void perform(async () => {
    const availability = await accountClient.checkAvailability();
    if (availability.state === "disabled") {
      serviceDisabled = true;
      notice =
        "Classroom hosting is not enabled on this website. Use the address provided by your administrator.";
      return;
    }
    const session = await accountClient.restoreSession();
    if (!session) {
      notice = googleNotice ?? "Sign in to open your classrooms.";
      errorNotice = googleNotice !== null;
      return;
    }
    rooms = await teacherClient.list();
    operator = await canInvite();
    signedIn = true;
    await restoreWorkspaceLocation();
    rememberLocation(true);
    notice = "Your classroom workspace is up to date.";
  });
}
