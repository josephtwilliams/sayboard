import { createElement as el, createButton as button } from "./dom";
import { createBoardArranger, type ArrangementSession } from "./board-arranger";
import "./board-arranger.css";
import { renderSymbol } from "./symbols";
import { createTypeAndSpeak } from "./type-and-speak";
import "./type-and-speak.css";
import { showDismissibleModal } from "./modal";
import "./editor-ux.css";
import { createAccountPanel } from "./account-panel";
import { createClassroomPanel } from "./classroom-panel";
import { createClassroomSync, type SyncState } from "./classroom-sync";
import { teacherClient } from "./classroom-client";
import { accountClient } from "./account";
import { id, type ProfileDetail } from "./classroom-contract";
import { createSymbolPicker } from "./symbol-picker";
import { placeTile, isTileSize } from "./layout";
import { loadTheme, applyTheme } from "./theme";
import { createLocalSpeech } from "./speech/local-speech";
import { createCategoryNavigation } from "./category-navigation";
import {
  loadStoredBoard,
  saveStoredBoard,
  serializeBoard,
} from "./board-storage";
import { hasBoardChanges } from "./editor-state";
import { columnsKey } from "./device-layout";
import {
  deviceLayoutKey,
  resolveDeviceLayout,
  isCompactPhoneLayout,
  hasDeviceLayoutChanges,
} from "./compact-layout";
import { createDeviceLayoutControls } from "./compact-controls";
import { createFullscreen } from "./fullscreen";

import {
  isIcon,
  parseBoard,
  starterBoard,
  moveTile,
  boardPage,
  removeTile,
  type WordTile,
  type Tile,
  type Board,
} from "./board";
import "./style.css";
import "./layout.css";
import "./picker.css";
import "./account.css";
import "./categories.css";
import "./classroom-sync.css";
import "./fullscreen.css";
import "./compact-layout.css";
const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing app root");
const teacherParameters = new URLSearchParams(location.search);
const teacherBoardRequest = teacherParameters.get("teacherBoard");
let teacherEditing: ProfileDetail | null = null;
let teacherSaving = false;
function teacherDashboard() {
  const classroom = teacherParameters.get("classroom");
  return (
    "/teacher" +
    (classroom && teacherEditing
      ? `#${encodeURIComponent(classroom)}/${teacherEditing.id}`
      : "")
  );
}
const fullscreen = createFullscreen(root);
let board = starterBoard();
let storageError = "";
let storageBlocked = false;
let hasStoredBoard = false;
let replacementAuthorizedDraft: Board | null = null;
try {
  const loaded = loadStoredBoard(localStorage);
  if (loaded.kind === "loaded") {
    board = loaded.board;
    hasStoredBoard = true;
  } else if (loaded.kind === "unavailable") {
    storageError = loaded.message;
    storageBlocked = true;
  }
} catch {
  storageError =
    "Device storage is unavailable. Your saved board has not been replaced.";
  storageBlocked = true;
}
let activeBoardId: string | null = null;
let theme = loadTheme();
document.documentElement.dataset.theme = theme;
let draft: Board | null = null;
let caregiverUnlocked = false;
const expandedSettings = new Set<string>();
let arrangement: ArrangementSession | null = null;
let deviceLayout = resolveDeviceLayout(
  null,
  null,
  window.innerWidth,
  board.size,
);
try {
  deviceLayout = resolveDeviceLayout(
    localStorage.getItem(deviceLayoutKey),
    localStorage.getItem(columnsKey),
    window.innerWidth,
    board.size,
  );
  localStorage.setItem(deviceLayoutKey, JSON.stringify(deviceLayout));
} catch {
  // Restricted storage keeps this layout stable for the current session.
}
let draftDeviceLayout = { ...deviceLayout };
let layoutSaveWarning = "";
let voices: SpeechSynthesisVoice[] = [];
let selected: string | null = null;
let typedText = "";
let typedMessagePending = false;
let lastInteraction = 0;
const heldPointers = new Set<number>();
let classroomPanelCleanup: (() => void) | undefined;
let classroomSync: ReturnType<typeof createClassroomSync> | null = null;
let classroomSyncState: SyncState = { kind: "unlinked" };
const recordInteraction = () => {
  lastInteraction = Date.now();
};
window.addEventListener(
  "pointerdown",
  (event) => {
    heldPointers.add(event.pointerId);
    recordInteraction();
  },
  true,
);
window.addEventListener(
  "pointerup",
  (event) => {
    heldPointers.delete(event.pointerId);
    recordInteraction();
  },
  true,
);
window.addEventListener(
  "pointercancel",
  (event) => heldPointers.delete(event.pointerId),
  true,
);
window.addEventListener("keydown", recordInteraction, true);
window.addEventListener("input", recordInteraction, true);
window.addEventListener("scroll", recordInteraction, true);
const localSpeech = createLocalSpeech();
let speechControlsCleanup: (() => void) | undefined;
let speechToken = 0;
let watchdog: ReturnType<typeof setTimeout> | undefined;
const tileButtons = new Map<string, HTMLButtonElement>();
const supported =
  "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
function hasUnsavedDraft(): boolean {
  return (
    draft !== null &&
    (hasBoardChanges(board, draft) ||
      hasDeviceLayoutChanges(deviceLayout, draftDeviceLayout) ||
      (storageBlocked && replacementAuthorizedDraft === draft))
  );
}
window.addEventListener("beforeunload", (event) => {
  if (hasUnsavedDraft()) event.preventDefault();
});
async function confirmChange(message: string): Promise<boolean> {
  const dialog = el("dialog", "tile-dialog");
  const title = el("h2", "", "Confirm board change");
  title.id = "confirmation-title";
  dialog.setAttribute("aria-labelledby", title.id);
  dialog.append(title, el("p", "", message));
  const actions = el("div", "dialog-actions");
  let approved = false;
  return new Promise((resolve) => {
    const cancel = button("Cancel", () => dialog.close());
    actions.append(
      cancel,
      button(
        "Confirm",
        () => {
          approved = true;
          dialog.close();
        },
        "button primary",
      ),
    );
    dialog.append(actions);
    showDismissibleModal(dialog, { onClosed: () => resolve(approved) });
    cancel.focus();
  });
}
function status(text: string, error = false) {
  const node = document.querySelector<HTMLElement>("#status");
  if (node) {
    node.textContent = text;
    node.classList.toggle("error", error);
  }
}
function finishSpeech() {
  clearTimeout(watchdog);
  selected = null;
  document.querySelectorAll(".tile").forEach((tile) => {
    tile.classList.remove("speaking");
    tile.removeAttribute("aria-current");
  });
}
function stop() {
  speechToken++;
  localSpeech.engine.cancel();
  finishSpeech();
}
function speak(tile: WordTile, settings: Board = board) {
  speakText(tile.phrase, tile.id, settings);
}
function speakText(phrase: string, id: string | null, settings: Board = board) {
  stop();
  const token = speechToken;
  status(`Selected: ${phrase}`);
  selected = id ?? "typed-speech";
  if (id !== null) {
    tileButtons.get(id)?.classList.add("speaking");
    tileButtons.get(id)?.setAttribute("aria-current", "true");
  }
  const armWatchdog = (delay: number) => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (token === speechToken && selected) {
        stop();
        status(
          `Selected: ${phrase}. Speech did not finish. Check device sound and try again.`,
          true,
        );
      }
    }, delay);
  };
  armWatchdog(15000);
  localSpeech.engine.speak(phrase, {
    rate: settings.rate,
    systemVoiceURI: settings.voice,
    onStart: () => {
      if (token === speechToken) {
        status(`Speaking: ${phrase}`);
        armWatchdog(
          Math.max(30000, 15000 + (phrase.length * 200) / settings.rate),
        );
      }
    },
    onEnd: () => {
      if (token === speechToken) {
        // Device fallback can finish while local audio is still being cached.
        finishSpeech();
        status(`Said: ${phrase}`);
      }
    },
    onError: (detail) => {
      if (token === speechToken) {
        finishSpeech();
        status(`Selected: ${phrase}. ${detail}`, true);
        const dialog = el("dialog", "tile-dialog");
        const title = el("h2", "", "Speech unavailable");
        title.id = "speech-error-title";
        dialog.setAttribute("aria-labelledby", title.id);
        const close = button("Close", () => dialog.close());
        dialog.append(
          title,
          el(
            "p",
            "",
            `${detail} Check sound or choose a device voice in caregiver settings. Words remain visible.`,
          ),
          close,
        );
        showDismissibleModal(dialog);
        close.focus();
      }
    },
  });
}
function persist(next: Board) {
  if (teacherBoardRequest) {
    storageError =
      "This classroom draft must be saved to the teacher workspace. Your device board is unchanged.";
    return false;
  }
  if (storageBlocked && next !== replacementAuthorizedDraft) {
    storageError =
      "The saved board is retained. Import a backup, load an account copy, or confirm Reset before saving a replacement.";
    return false;
  }
  try {
    saveStoredBoard(localStorage, next);
    board = next;
    storageError = "";
    storageBlocked = false;
    replacementAuthorizedDraft = null;
    deviceLayout = { ...draftDeviceLayout };
    layoutSaveWarning = "";
    try {
      localStorage.setItem(deviceLayoutKey, JSON.stringify(deviceLayout));
    } catch {
      layoutSaveWarning =
        "Board saved on this device. Display preferences could not be saved and apply for this session only.";
    }
    return true;
  } catch (error) {
    storageError =
      error instanceof Error && error.message.includes("too large")
        ? error.message
        : "Could not save on this device. Storage may be full or blocked. Export your draft before leaving.";
    return false;
  }
}
function exportBoard(value: Board) {
  try {
    const url = URL.createObjectURL(
      new Blob([serializeBoard(value)], { type: "application/json" }),
    );
    const a = el("a");
    a.href = url;
    a.download = "sayboard.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    status(
      error instanceof Error ? error.message : "Could not export this board.",
      true,
    );
  }
}
function openCategory(id: string) {
  stop();
  activeBoardId = id;
  render();
  window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  document
    .querySelector<HTMLButtonElement>(".board-home")
    ?.focus({ preventScroll: true });
}
function openCaregiverEntry() {
  const dialog = el("dialog", "tile-dialog caregiver-dialog");
  const heading = el("h2", "", "Caregiver tools");
  heading.id = "caregiver-title";
  dialog.setAttribute("aria-labelledby", heading.id);
  dialog.append(
    heading,
    el(
      "p",
      "",
      "Editing is for caregivers and support partners. Open caregiver mode to change words and voices.",
    ),
    el(
      "p",
      "subtitle",
      "This extra step helps prevent accidental edits. It is not a security lock.",
    ),
  );
  const actions = el("div", "dialog-actions");
  const cancel = button("Keep communicating", () => dialog.close());
  actions.append(
    cancel,
    button("Add word or phrase", () => {
      caregiverUnlocked = true;
      stop();
      draft = structuredClone(board);
      draftDeviceLayout = { ...deviceLayout };
      dialog.close();
      render();
      editTile(draft, null, true);
    }),
    button("Arrange board", () => {
      caregiverUnlocked = true;
      stop();
      arrangement = {
        board: structuredClone(board),
        selectedId: null,
        message: "",
      };
      draftDeviceLayout = { ...deviceLayout };
      dialog.close();
      render();
      document.querySelector<HTMLButtonElement>(".arrange-save")?.focus();
    }),
    button(
      "Edit board and settings",
      () => {
        caregiverUnlocked = true;
        expandedSettings.clear();
        stop();
        draft = structuredClone(board);
        draftDeviceLayout = { ...deviceLayout };
        dialog.close();
        render();
        document
          .querySelector<HTMLButtonElement>(".editor-toolbar button")
          ?.focus();
      },
      "button primary",
    ),
  );
  dialog.append(actions);
  showDismissibleModal(dialog);
  cancel.focus();
}
function openQuickAdd() {
  const position = { x: window.scrollX, y: window.scrollY };
  const destination =
    board.tiles.find(
      (tile) => tile?.kind === "category" && tile.subBoardId === activeBoardId,
    )?.label ?? "Home board";
  const restorePosition = () => {
    document
      .querySelector<HTMLButtonElement>(".add-tile-access")
      ?.focus({ preventScroll: true });
    window.scrollTo({ left: position.x, top: position.y, behavior: "instant" });
  };
  const add = () => {
    caregiverUnlocked = true;
    const page = boardPage(board, activeBoardId);
    if (page.tiles.length >= 60 && !page.tiles.includes(null)) {
      status("All 60 slots are filled. Remove a word to make a space.", true);
      return;
    }
    stop();
    draft = structuredClone(board);
    draftDeviceLayout = { ...deviceLayout };
    editTile(draft, null, true, "word", restorePosition);
  };
  if (caregiverUnlocked) {
    add();
    return;
  }
  const dialog = el("dialog", "tile-dialog caregiver-dialog");
  const heading = el("h2", "", "Add a tile");
  heading.id = "add-tile-title";
  dialog.setAttribute("aria-labelledby", heading.id);
  dialog.append(
    heading,
    el("p", "", `Caregiver editing: add a word or phrase to ${destination}.`),
  );
  const actions = el("div", "dialog-actions");
  const cancel = button("Keep communicating", () => dialog.close());
  actions.append(
    cancel,
    button(
      "Continue to add tile",
      () => {
        dialog.close();
        add();
      },
      "button primary",
    ),
  );
  dialog.append(actions);
  showDismissibleModal(dialog);
  cancel.focus();
}
function render() {
  if (!root) return;
  speechControlsCleanup?.();
  speechControlsCleanup = undefined;
  classroomPanelCleanup?.();
  classroomPanelCleanup = undefined;
  root.replaceChildren();
  tileButtons.clear();
  const showing = arrangement?.board ?? draft ?? board;
  if (
    activeBoardId !== null &&
    !showing.subBoards.some((page) => page.id === activeBoardId)
  )
    activeBoardId = null;
  const page = boardPage(showing, activeBoardId);
  const navigation = createCategoryNavigation({
    board: showing,
    activeBoardId,
    onHome: (categoryTileId) => {
      stop();
      activeBoardId = null;
      render();
      if (categoryTileId === null) return;
      if (arrangement) {
        Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            "[data-arrange-tile-id]",
          ),
        )
          .find((node) => node.dataset.arrangeTileId === categoryTileId)
          ?.focus();
      } else if (draft) {
        Array.from(
          document.querySelectorAll<HTMLButtonElement>("[data-category-id]"),
        )
          .find((node) => node.dataset.categoryId === categoryTileId)
          ?.focus();
      } else tileButtons.get(categoryTileId)?.focus();
    },
  });
  const shell = el("main", "shell");
  if (!draft && isCompactPhoneLayout(deviceLayout))
    shell.dataset.compactPhone = "true";
  const header = el("header", "header");
  const brand = el("div", "brand");
  brand.append(renderSymbol("message-circle"), el("span", "", "sayboard"));
  const controls = el("div", "header-controls");
  controls.dataset.fullscreenChrome = "";
  const themeFeedback = el("span", "sr-only");
  themeFeedback.role = "status";
  themeFeedback.setAttribute("aria-live", "polite");
  const themeButton = button(
    "",
    () => {
      theme = theme === "light" ? "dark" : "light";
      const saved = applyTheme(theme);
      updateThemeButton();
      themeFeedback.textContent = saved
        ? `${theme === "dark" ? "Dark" : "Light"} mode on.`
        : `${theme === "dark" ? "Dark" : "Light"} mode on for this session. Device storage is unavailable.`;
    },
    "button quiet icon-button",
  );
  function updateThemeButton() {
    const label =
      theme === "light" ? "Switch to dark mode" : "Switch to light mode";
    themeButton.setAttribute("aria-label", label);
    themeButton.title = label;
    themeButton.replaceChildren(
      renderSymbol(theme === "light" ? "moon" : "sun"),
    );
  }
  updateThemeButton();
  const caregiver = button(
    teacherEditing ? "Teacher dashboard" : draft ? "Back to board" : "",
    async () => {
      if (teacherEditing) {
        if (
          hasUnsavedDraft() &&
          !(await confirmChange("Discard unsaved classroom draft changes?"))
        )
          return;
        stop();
        draft = null;
        location.assign(teacherDashboard());
        return;
      }
      if (draft) {
        if (
          hasUnsavedDraft() &&
          !(await confirmChange("Discard unsaved caregiver changes?"))
        )
          return;
        stop();
        draft = null;
        replacementAuthorizedDraft = null;
        render();
        (
          document.querySelector<HTMLButtonElement>(".tile") ??
          document.querySelector<HTMLButtonElement>(".caregiver-access")
        )?.focus();
      } else {
        openCaregiverEntry();
      }
    },
    `button quiet caregiver-access ${draft ? "" : "icon-button"}`,
  );
  if (!draft && !teacherEditing) {
    caregiver.append(renderSymbol("settings"));
    caregiver.setAttribute("aria-label", "Caregiver controls");
    caregiver.title = "Caregiver controls";
  }
  caregiver.disabled = arrangement !== null;
  controls.append(themeButton, caregiver, themeFeedback);
  if (!draft && !teacherEditing) {
    const destination =
      board.tiles.find(
        (tile) =>
          tile?.kind === "category" && tile.subBoardId === activeBoardId,
      )?.label ?? "Home board";
    const add = button(
      "",
      openQuickAdd,
      "button quiet icon-button add-tile-access",
    );
    add.append(renderSymbol("plus"));
    add.setAttribute("aria-label", `Add tile to ${destination}`);
    add.title = `Add tile to ${destination}`;
    add.disabled = arrangement !== null;
    controls.prepend(add);
  }
  if (!draft) controls.prepend(fullscreen.createEntryButton());
  header.append(activeBoardId === null ? brand : navigation, controls);
  if (draft) {
    header.classList.add("editor-header");
    const context = el("div", "editor-context");
    context.append(
      el(
        "h1",
        "",
        teacherEditing ? `Edit ${teacherEditing.label}` : "Edit board",
      ),
    );
    if (activeBoardId === null)
      context.append(el("p", "editor-location", "Home board"));
    else context.append(navigation);
    const row = el("div", "editor-head-row");
    row.append(context, controls);
    header.replaceChildren(row);
  }
  if (!draft) header.append(fullscreen.createControls());
  shell.append(header);
  if (arrangement) {
    const session = arrangement;
    shell.append(
      createBoardArranger({
        session,
        pageId: activeBoardId,
        columns: deviceLayout.columns,
        size: deviceLayout.size ?? page.size,
        onOpen: openCategory,
        onSave: () => {
          if (!persist(session.board)) return storageError;
          arrangement = null;
          render();
          document.querySelector<HTMLButtonElement>(".tile")?.focus();
          return null;
        },
        onCancel: () => {
          arrangement = null;
          render();
          document.querySelector<HTMLButtonElement>(".tile")?.focus();
        },
      }),
    );
  } else if (draft) {
    renderEditor(shell, draft);
  } else {
    shell.append(el("h1", "sr-only", "Communication board"));
    const hasWords = page.tiles.some((tile) => tile !== null);
    const live = el(
      "p",
      "sr-only",
      !hasWords ? "No words on this board." : "Tap a word to speak.",
    );
    live.id = "status";
    live.role = "status";
    live.setAttribute("aria-live", "polite");
    shell.append(live);
    const syncIndicator = el("p", "classroom-sync-status", syncDescription());
    syncIndicator.hidden = classroomSyncState.kind === "unlinked";
    syncIndicator.dataset.fullscreenChrome = "";
    shell.append(syncIndicator);

    if (storageError) shell.append(el("p", "notice error", storageError));
    if (!hasWords) {
      const empty = el("section", "notice empty-board");
      const emptyCaregiver = button("Open caregiver tools", openCaregiverEntry);
      emptyCaregiver.dataset.fullscreenChrome = "";
      empty.append(
        el("h2", "", "No words yet"),
        el(
          "p",
          "",
          "Open caregiver tools to add words or restore starter words. Your saved empty slots are kept until you choose a change.",
        ),
        emptyCaregiver,
      );
      shell.append(empty, typeAndSpeak());
      root.append(shell);
      fullscreen.refresh();
      return;
    }
    const viewport = el("div", "board-viewport");
    viewport.setAttribute("role", "region");
    viewport.setAttribute(
      "aria-label",
      "Communication board, scroll to reach all words",
    );
    viewport.tabIndex = 0;
    const grid = el("div", "grid");
    grid.setAttribute("aria-label", "Communication words");
    grid.dataset.size = deviceLayout.size ?? page.size;
    grid.style.setProperty("--board-columns", String(deviceLayout.columns));
    page.tiles.forEach((tile, i) => {
      if (!tile) {
        const empty = el("div", "empty-slot");
        empty.setAttribute("aria-label", `Empty word slot ${i + 1}`);
        grid.append(empty);
        return;
      }
      const b = button(
        "",
        () => {
          if (tile.kind === "category") openCategory(tile.subBoardId);
          else speak(tile);
        },
        `tile ${tile.tone}${tile.kind === "category" ? " category-tile" : ""}`,
      );
      b.onfocus = () => {
        if (b.matches(":focus-visible"))
          b.scrollIntoView({ block: "nearest", inline: "nearest" });
      };
      tileButtons.set(tile.id, b);
      b.setAttribute(
        "aria-label",
        tile.kind === "category"
          ? `Open ${tile.label} category`
          : `Say ${tile.label}`,
      );
      b.append(renderSymbol(tile.icon), el("span", "", tile.label));
      if (tile.kind === "category")
        b.append(el("span", "category-indicator", "Open category"));
      grid.append(b);
    });
    viewport.append(grid);
    shell.append(viewport, typeAndSpeak());
  }
  root.append(shell);
  fullscreen.refresh();
  if (teacherSaving)
    root
      .querySelectorAll<
        HTMLInputElement | HTMLButtonElement | HTMLSelectElement
      >("input,button,select")
      .forEach((control) => (control.disabled = true));
}
function typeAndSpeak() {
  return createTypeAndSpeak({
    text: typedText,
    onChange: (text) => {
      typedText = text;
      typedMessagePending = Boolean(text.trim());
    },
    onSpeak: (text) => {
      typedMessagePending = false;
      speakText(text, null);
    },
  });
}
function focusEditorAction(label: string) {
  Array.from(
    document.querySelectorAll<HTMLButtonElement>(".editor-toolbar button"),
  )
    .find((b) => b.textContent === label)
    ?.focus();
}
function focusEditorRow(index: number, preferred = "button") {
  const row = document.querySelectorAll(".edit-row")[index];
  if (!row) return;
  const target = row.querySelector<HTMLButtonElement>(preferred);
  if (target && !target.disabled) target.focus();
  else
    Array.from(row.querySelectorAll<HTMLButtonElement>("button"))
      .find((b) => !b.disabled)
      ?.focus();
}
function renderEditor(shell: HTMLElement, working: Board) {
  shell.classList.add("editor-workspace");
  const page = boardPage(working, activeBoardId);
  const header = shell.querySelector(".header");
  const saveState = el("p", "editor-save-state");
  saveState.role = "status";
  saveState.setAttribute("aria-live", "polite");
  const updateSaveState = () => {
    saveState.textContent = hasUnsavedDraft()
      ? teacherEditing
        ? "Unsaved classroom draft changes"
        : "Unsaved changes on this device"
      : "No unsaved changes";
  };
  updateSaveState();
  shell.addEventListener("input", updateSaveState);
  shell.addEventListener("change", updateSaveState);
  shell.append(
    el(
      "p",
      "subtitle",
      teacherEditing
        ? "Changes stay in this draft until you save to the teacher workspace. Publish separately from the dashboard. The device board is unchanged."
        : "Make this board work for the person using it. Save your changes when you’re ready to return to the board.",
    ),
  );
  const tools = el("div", "editor-toolbar");
  const saveTools = el("div", "editor-toolbar editor-save-tools");
  const saveBoardButton = button(
    teacherEditing ? "Save classroom draft" : "Save board",
    async () => {
      if (teacherEditing) {
        if (teacherSaving) return;
        teacherSaving = true;
        document
          .querySelectorAll<
            HTMLInputElement | HTMLButtonElement | HTMLSelectElement
          >("#app input, #app button, #app select")
          .forEach((control) => (control.disabled = true));
        try {
          const saved = await teacherClient.save(
            teacherEditing.id,
            teacherEditing.revision,
            structuredClone(working),
          );
          teacherEditing = saved;
          board = saved.board;
          draft = null;
          location.assign(teacherDashboard());
        } catch (error) {
          teacherSaving = false;
          render();
          status(
            error instanceof Error
              ? error.message
              : "The classroom draft could not be saved. Export it before leaving.",
            true,
          );
        }
        return;
      }
      if (persist(working)) {
        stop();
        draft = null;
        render();
        document.querySelector<HTMLButtonElement>(".caregiver-access")?.focus();
        status(
          layoutSaveWarning || "Board saved on this device.",
          Boolean(layoutSaveWarning),
        );
      } else {
        render();
        focusEditorAction("Save board");
      }
    },
    "button primary",
  );
  saveTools.append(saveBoardButton, saveState);
  header?.append(saveTools);
  tools.append(
    button("Add word or phrase", () => editTile(working, null)),
    ...(activeBoardId === null
      ? [
          button("Add category", () =>
            editTile(working, null, false, "category"),
          ),
        ]
      : []),
  );
  const upload = el("input");
  upload.type = "file";
  upload.accept = ".json,application/json";
  upload.id = "import";
  upload.hidden = true;
  upload.onchange = async () => {
    const file = upload.files?.[0];
    if (!file) return;
    try {
      if (file.size > 100000)
        throw new Error(
          "File is too large. Use a Sayboard JSON file under 100 KB.",
        );
      const next = parseBoard(JSON.parse(await file.text()));
      if (
        await confirmChange(
          "Replace this draft with the imported board? Save to apply it.",
        )
      ) {
        stop();
        draft = next;
        replacementAuthorizedDraft = next;
        activeBoardId = null;
        render();
        focusEditorAction("Import board");
      }
    } catch (error) {
      status(
        error instanceof Error ? error.message : "Could not import this file.",
        true,
      );
    } finally {
      upload.value = "";
    }
  };
  const backups = el("details", "settings-group");
  backups.append(el("summary", "", "Backup and transfer"));
  const backupTools = el("div", "editor-toolbar");
  backupTools.append(
    button("Export board", () => exportBoard(working)),
    button("Import board", () => upload.click()),
    upload,
  );
  backups.append(backupTools);
  const notice = el(
    "p",
    "notice",
    storageError ||
      (teacherEditing
        ? "Save classroom draft stores these changes in your teacher workspace. Publish separately to make a version available to linked devices."
        : "Changes stay on this device until you choose to save an account copy. Export a backup to move your board."),
  );
  notice.id = "status";
  notice.role = "status";
  shell.append(notice);
  const displayGroup = el("details", "settings-group");
  displayGroup.append(el("summary", "", "Display and tile size"));
  const display = el("section", "settings");
  const voiceGroup = el("details", "settings-group");
  voiceGroup.append(el("summary", "", "Voice and speaking speed"));
  const settings = el("section", "settings");
  const sizeLabel = el("label", "", "Default tile size for this board");
  const sizeSelect = el("select");
  sizeSelect.setAttribute("aria-label", "Default tile size for this board");
  sizeSelect.append(
    new Option("Small", "small"),
    new Option("Standard", "standard"),
    new Option("Large", "large"),
    new Option("Extra large", "extra-large"),
  );
  sizeSelect.value = page.size;
  sizeSelect.onchange = () => {
    if (isTileSize(sizeSelect.value)) page.size = sizeSelect.value;
  };
  sizeLabel.append(sizeSelect);
  display.append(
    sizeLabel,
    el(
      "p",
      "",
      "This size travels with the board in backups. You can choose a different size for this device below. Columns stay fixed when tile size changes.",
    ),
  );
  if (!teacherEditing)
    display.append(
      createDeviceLayoutControls({
        layout: draftDeviceLayout,
        onChange: (next) => {
          draftDeviceLayout = next;
          updateSaveState();
        },
      }),
    );
  const voiceLabel = el("label", "", "Device voice for speech and fallback");
  const select = el("select");
  select.setAttribute("aria-label", "Device voice for speech and fallback");
  select.id = "voice";
  select.append(new Option("Automatic on-device voice", ""));
  // Some devices populate voices after startup without a voiceschanged event.
  if (supported) voices = window.speechSynthesis.getVoices();
  voices.forEach((v) =>
    select.append(
      new Option(
        `${v.name} · ${v.lang}${v.localService ? " · on device" : " · may use network"}`,
        v.voiceURI,
      ),
    ),
  );
  Array.from(select.options).forEach((option) => {
    if (
      option.value &&
      !voices.find((v) => v.voiceURI === option.value)?.localService
    )
      option.disabled = true;
  });
  select.value = working.voice;
  select.onchange = () => (working.voice = select.value);
  voiceLabel.append(select);
  const speedLabel = el("label", "", "Speaking speed");
  const speed = el("input");
  speed.setAttribute("aria-label", "Speaking speed");
  speed.type = "range";
  speed.min = "0.5";
  speed.max = "1.5";
  speed.step = "0.05";
  speed.value = String(working.rate);
  speedLabel.append(speed);
  const rate = el("output", "", `${working.rate}×`);
  speed.oninput = () => {
    working.rate = Number(speed.value);
    rate.textContent = `${working.rate}×`;
  };
  speedLabel.append(rate);
  settings.append(
    voiceLabel,
    speedLabel,
    button("Test voice", () =>
      speak(
        {
          kind: "word",
          id: "voice-test",
          label: "Test",
          phrase: "This is my voice.",
          icon: "message-circle",
          tone: "mint",
        },
        working,
      ),
    ),
    button("Stop speaking", () => {
      stop();
      status("Speech stopped.");
    }),
    el(
      "p",
      "",
      "Voices depend on your device. Remote voices are disabled to keep spoken words on this device. If no local voice is available, words remain visible without speech. Offline speech is not guaranteed.",
    ),
  );
  speechControlsCleanup = localSpeech.mountControls(
    settings,
    () => working.rate,
    () =>
      [...working.tiles, ...working.subBoards.flatMap((page) => page.tiles)]
        .filter((tile): tile is WordTile => tile?.kind === "word")
        .map((tile) => tile.phrase),
  );
  displayGroup.append(display);
  voiceGroup.append(settings);

  if (!teacherEditing)
    backups.append(
      createAccountPanel({
        working,
        confirm: confirmChange,
        applyBoard: (next: Board) => {
          stop();
          draft = next;
          replacementAuthorizedDraft = next;
          activeBoardId = null;
          render();
          status(
            "Account board loaded into the draft. Save board to apply it on this device.",
          );
          focusEditorAction("Save board");
        },
      }),
    );
  if (!teacherEditing && classroomSync) {
    const classroomPanel = createClassroomPanel({
      sync: classroomSync,
      confirm: confirmChange,
      setPending: (pending) => {
        saveBoardButton.disabled = pending;
        if (pending) saveState.textContent = "Connecting the classroom…";
        else updateSaveState();
      },
    });
    classroomPanelCleanup = classroomPanel.dispose;
    backups.append(classroomPanel.element);
  }
  const workspace = el("div", "editor-workspace-layout");
  const navigation = el("nav", "editor-section-nav");
  navigation.setAttribute("aria-label", "Board editor sections");
  navigation.append(el("p", "eyebrow", "MAKE IT YOURS"));
  const content = el("div", "editor-workspace-content");
  const words = el("section", "editor-words-section");
  words.id = "editor-words";
  const wordsHeading = el("h2", "", "Words and categories");
  words.append(
    wordsHeading,
    el(
      "p",
      "editor-section-description",
      "Choose the words that matter. Empty slots keep familiar words in place.",
    ),
    tools,
  );
  const sections = [
    {
      target: words,
      label: "Words & categories",
      icon: "message-circle",
      help: "Build your vocabulary",
      tone: "mint",
    },
    {
      target: displayGroup,
      label: "Display",
      icon: "layout-grid",
      help: "Tile size & device layout",
      tone: "blue",
    },
    {
      target: voiceGroup,
      label: "Voice",
      icon: "volume",
      help: "Voice & speaking speed",
      tone: "peach",
    },
    {
      target: backups,
      label: "Backup & transfer",
      icon: "archive",
      help: "Save, import & connect",
      tone: "lavender",
    },
  ];
  for (const [index, section] of sections.entries()) {
    if (index > 0) section.target.id = `editor-section-${index}`;
    const jump = el("a", "editor-section-link");
    jump.href = `#${section.target.id}`;
    const icon = el("span", `editor-nav-icon ${section.tone}`);
    icon.append(renderSymbol(section.icon));
    const text = el("span", "");
    text.append(el("strong", "", section.label), el("small", "", section.help));
    jump.append(icon, text);
    jump.onclick = (event) => {
      event.preventDefault();
      if (section.target instanceof HTMLDetailsElement)
        section.target.open = true;
      section.target.scrollIntoView({ block: "start", behavior: "instant" });
      const focusTarget =
        section.target.querySelector<HTMLElement>("summary, h2");
      if (focusTarget) {
        if (focusTarget.tagName !== "SUMMARY") focusTarget.tabIndex = -1;
        focusTarget.focus({ preventScroll: true });
      }
    };
    navigation.append(jump);
  }
  workspace.append(navigation, content);
  shell.append(workspace);
  if (location.hostname === "sayboard.org") {
    const migration = el(
      "a",
      "button",
      "Recover a board from the old website address",
    );
    migration.href = "https://sayboard.vercel.app/move-board.html";
    backups.append(
      el(
        "p",
        "",
        "Previously used sayboard.vercel.app? Your board is still stored under that address.",
      ),
      migration,
    );
  }
  const list = el("div", "edit-list");
  page.tiles.forEach((tile, i) => {
    const row = el("div", "edit-row");
    row.append(el("span", "position", String(i + 1)));
    if (tile) {
      const summary = el("div", "word-summary");
      summary.append(
        renderSymbol(tile.icon),
        el("strong", "", tile.label),
        el("span", "", tile.kind === "category" ? "Category" : tile.phrase),
      );
      row.append(
        summary,
        button(
          `Edit ${tile.label}`,
          () => editTile(working, i),
          "button compact",
        ),
      );
      if (tile.kind === "category") {
        const open = button(
          `Open ${tile.label} category`,
          () => openCategory(tile.subBoardId),
          "button compact",
        );
        open.dataset.categoryId = tile.id;
        row.append(open);
      }
    } else {
      row.append(
        el("span", "word-summary", "Empty slot"),
        button("Add here", () => editTile(working, i), "button compact"),
      );
    }
    const prev = button(
      "↑",
      () => {
        page.tiles = moveTile(page.tiles, i, -1);
        render();
        focusEditorRow(i - 1, ".move-up");
      },
      "button compact move-up",
    );
    prev.disabled = i === 0;
    prev.setAttribute("aria-label", `Swap slot ${i + 1} with slot ${i}`);
    const next = button(
      "↓",
      () => {
        page.tiles = moveTile(page.tiles, i, 1);
        render();
        focusEditorRow(i + 1, ".move-down");
      },
      "button compact move-down",
    );
    next.disabled = i === page.tiles.length - 1;
    next.setAttribute("aria-label", `Swap slot ${i + 1} with slot ${i + 2}`);
    row.append(prev, next);
    if (tile)
      row.append(
        button(
          "Remove",
          async () => {
            if (
              await confirmChange(
                tile.kind === "category"
                  ? `Remove "${tile.label}" and all words in its category? Its Home slot will stay empty.`
                  : `Remove “${tile.label}”? Its slot will stay empty to keep other words in place.`,
              )
            ) {
              removeTile(working, page, i);
              render();
              focusEditorRow(i);
            }
          },
          "button compact danger",
        ),
      );
    list.append(row);
  });
  words.append(list);
  content.append(words, displayGroup, voiceGroup, backups);
  shell
    .querySelectorAll<HTMLDetailsElement>(".settings-group")
    .forEach((group) => {
      const name = group.querySelector("summary")?.textContent ?? "";
      group.open = expandedSettings.has(name);
      group.addEventListener("toggle", () => {
        if (!group.isConnected) return;
        if (group.open) expandedSettings.add(name);
        else expandedSettings.delete(name);
      });
    });
  const safety = el("section", "safety");
  safety.append(
    el("h2", "", "About this prototype"),
    el(
      "p",
      "",
      "A starting point for personal communication. It has not been clinically validated. Adapt it with the person and their support team, and keep their existing AAC system available.",
    ),
    el(
      "p",
      "",
      teacherEditing
        ? "Classroom drafts and published vocabulary are stored on the classroom server. Spoken messages are not collected. Learners keep their working boards on their own devices."
        : "Your local board stays in this browser unless you choose to save a copy to your account. Clearing site data removes local words. Caregiver mode is an editing boundary, not a security lock.",
    ),
    button(
      "Reset to starter words",
      async () => {
        if (
          await confirmChange(
            "Reset the draft to starter words? This replaces custom words and voice settings when you save. Export a backup first.",
          )
        ) {
          stop();
          draft = starterBoard();
          replacementAuthorizedDraft = draft;
          activeBoardId = null;
          render();
          document.querySelector<HTMLButtonElement>(".safety button")?.focus();
        }
      },
      "button danger",
    ),
  );
  content.append(safety);
}
function editTile(
  working: Board,
  index: number | null,
  quick = false,
  newKind: Tile["kind"] = "word",
  quickReturn?: () => void,
) {
  const page = boardPage(working, activeBoardId);
  if (index === null && page.tiles.length >= 60 && !page.tiles.includes(null)) {
    status("All 60 slots are filled. Remove a word to make a space.", true);
    return;
  }
  const current = index === null ? null : page.tiles[index];
  const isCategory =
    current?.kind === "category" || (!current && newKind === "category");
  const editingId = current?.id ?? crypto.randomUUID();
  const dialog = el("dialog", "tile-dialog word-dialog");
  const form = el("form");
  const heading = el(
    "h2",
    "",
    isCategory
      ? current
        ? "Edit category"
        : "Add category"
      : current
        ? "Edit word"
        : "Add word or phrase",
  );
  heading.id = "word-editor-title";
  const destination =
    working.tiles.find(
      (tile) => tile?.kind === "category" && tile.subBoardId === activeBoardId,
    )?.label ?? "Home board";
  dialog.setAttribute("aria-labelledby", heading.id);
  const location = el(
    "p",
    "editor-help",
    `${index === null ? "Adding to" : "Editing in"} ${destination}`,
  );
  form.append(
    heading,
    location,
    el(
      "p",
      "editor-help",
      isCategory
        ? "A category opens a separate board of words."
        : "Enter the text for the tile. We use the same text for speech unless you change it.",
    ),
  );
  const fields = el("div", "word-fields");
  function textField(title: string, value: string, max: number) {
    const wrapper = el("label", "", title);
    const input = el("input");
    input.value = value;
    input.maxLength = max;
    input.required = true;
    wrapper.append(input);
    fields.append(wrapper);
    return input;
  }
  const label = textField("Text on the tile", current?.label ?? "", 40);
  const phrase = textField("Text to speak", current?.phrase ?? "", 200);
  phrase.required = !isCategory;
  if (isCategory && phrase.parentElement) phrase.parentElement.hidden = true;
  form.append(fields);
  let phraseEdited = Boolean(current);
  const picker = createSymbolPicker({
    initialId: current?.icon ?? "message-circle",
    text: current?.label ?? "",
    explicit: Boolean(current),
  });
  form.append(picker.element);
  const placement = el("div", "word-fields");
  const positionLabel = el("label", "", "Board slot");
  const position = el("select");
  position.setAttribute("aria-label", "Board slot");
  for (let slot = 0; slot < 60; slot++) {
    const occupant = page.tiles[slot];
    const option = new Option(
      `Slot ${slot + 1}${occupant ? ` · ${occupant.label}${occupant.id === editingId ? " (current)" : " (occupied)"}` : " · empty"}`,
      String(slot),
    );
    option.disabled = Boolean(occupant && occupant.id !== editingId);
    position.append(option);
  }
  position.value = String(
    index ??
      (page.tiles.indexOf(null) >= 0
        ? page.tiles.indexOf(null)
        : page.tiles.length),
  );
  positionLabel.append(position);
  placement.append(positionLabel);
  const toneLabel = el("label", "", "Tile colour");
  const tone = el("select");
  tone.setAttribute("aria-label", "Tile colour");
  ["mint", "peach", "blue", "lavender"].forEach((name) =>
    tone.append(new Option(name, name)),
  );
  tone.value = current?.tone ?? "mint";
  toneLabel.append(tone);
  placement.append(toneLabel);
  const appearance = el("details", "editor-options");
  appearance.append(el("summary", "", "Colour and board position"));
  appearance.append(
    placement,
    el(
      "p",
      "placement-note",
      "Choose an empty slot. Moving a word leaves its old slot empty and keeps all other words in place.",
    ),
  );
  form.append(appearance);
  const dialogError = el("p", "notice error dialog-error");
  dialogError.role = "alert";
  form.append(dialogError);
  const actions = el("div", "dialog-actions");
  actions.append(button("Cancel", () => requestDismiss()));
  const save = el(
    "button",
    "button primary",
    quick ? "Save to board" : "Add to board draft",
  );
  if (current && !quick) save.textContent = "Apply changes";
  save.type = "submit";
  const updateSave = () => {
    save.disabled =
      !label.value.trim() || (!isCategory && !phrase.value.trim());
  };
  updateSave();
  actions.append(save);
  form.append(
    el(
      "p",
      "editor-help",
      quick
        ? "Save adds this tile on this device and returns to the same board."
        : "Then choose Save board to keep your changes on this browser.",
    ),
    actions,
  );
  const originalValues = () =>
    JSON.stringify([
      label.value,
      phrase.value,
      picker.selectedId(),
      position.value,
      tone.value,
    ]);
  let original = originalValues();
  let applied = false;
  const discard = el("div", "notice discard-edit");
  discard.hidden = true;
  const keepEditing = button("Keep editing", () => {
    discard.hidden = true;
    label.focus();
  });
  discard.append(
    el("p", "", "Discard this unsaved tile?"),
    keepEditing,
    button("Discard changes", () => dialog.close(), "button danger"),
  );
  form.append(discard);
  function requestDismiss() {
    if (originalValues() === original) dialog.close();
    else {
      discard.hidden = false;
      keepEditing.focus();
      discard.scrollIntoView({ block: "nearest" });
    }
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    label.setCustomValidity("");
    phrase.setCustomValidity("");
    if (!label.value.trim()) {
      label.setCustomValidity("Enter a tile label.");
      label.reportValidity();
      return;
    }
    if (!isCategory && !phrase.value.trim()) {
      phrase.setCustomValidity("Enter words to speak.");
      phrase.reportValidity();
      return;
    }
    const selectedIcon = picker.selectedId();
    if (!isIcon(selectedIcon)) {
      dialogError.textContent = "Choose a bundled icon or emoji.";
      return;
    }
    const fields: Omit<WordTile, "kind"> = {
      id: editingId,
      label: label.value.trim(),
      phrase: isCategory ? label.value.trim() : phrase.value.trim(),
      icon: selectedIcon,
      tone:
        tone.value === "peach"
          ? "peach"
          : tone.value === "blue"
            ? "blue"
            : tone.value === "lavender"
              ? "lavender"
              : "mint",
    };
    const tile: Tile = isCategory
      ? {
          ...fields,
          kind: "category",
          subBoardId:
            current?.kind === "category"
              ? current.subBoardId
              : crypto.randomUUID(),
        }
      : { ...fields, kind: "word" };
    const placed = placeTile(page.tiles, Number(position.value), tile);
    if (placed.kind === "occupied") {
      dialogError.textContent = `That slot contains ${placed.occupant.label}. Choose an empty slot. Other words have not moved.`;
      return;
    }
    if (placed.kind === "invalid") {
      dialogError.textContent = placed.message;
      return;
    }
    page.tiles = placed.tiles;
    if (tile.kind === "category" && current?.kind !== "category")
      working.subBoards.push({
        id: tile.subBoardId,
        tiles: [null],
        size: page.size,
      });
    // A failed device save still keeps the applied tile in the caregiver draft.
    applied = true;
    if (quick) {
      if (!persist(working)) {
        render();
        dialogError.textContent = `${storageError} Your word is kept in the caregiver draft.`;
        original = originalValues();
        save.textContent = "Retry save";
        return;
      }
      draft = null;
    }
    dialog.close();
    render();
    if (quick) {
      if (quickReturn) quickReturn();
      else tileButtons.get(editingId)?.focus();
      status(
        layoutSaveWarning || "Word saved on this device.",
        Boolean(layoutSaveWarning),
      );
    } else focusEditorRow(Number(position.value));
  };
  label.oninput = () => {
    label.setCustomValidity("");
    if (!phraseEdited) phrase.value = label.value;
    picker.updateSuggestions(`${label.value} ${phrase.value}`);
    updateSave();
  };
  phrase.oninput = () => {
    phraseEdited = true;
    phrase.setCustomValidity("");
    picker.updateSuggestions(`${label.value} ${phrase.value}`);
    updateSave();
  };
  dialog.append(form);
  showDismissibleModal(dialog, {
    onDismiss: requestDismiss,
    onClosed: () => {
      if (quick && !applied) {
        draft = null;
        render();
        document.querySelector<HTMLButtonElement>(".caregiver-access")?.focus();
        quickReturn?.();
      }
    },
  });
  label.focus();
}
if (supported) {
  const refresh = () => {
    voices = window.speechSynthesis.getVoices();
    if (draft) {
      const select = document.querySelector<HTMLSelectElement>("#voice");
      if (select) {
        select.replaceChildren(new Option("Automatic on-device voice", ""));
        voices.forEach((v) =>
          select.append(
            new Option(
              `${v.name} · ${v.lang}${v.localService ? " · on device" : " · may use network"}`,
              v.voiceURI,
            ),
          ),
        );
        Array.from(select.options).forEach((option) => {
          if (
            option.value &&
            !voices.find((v) => v.voiceURI === option.value)?.localService
          )
            option.disabled = true;
        });
        select.value = draft.voice;
      }
    }
  };
  window.speechSynthesis.addEventListener("voiceschanged", refresh);
  refresh();
}
if (teacherBoardRequest) {
  root.append(el("p", "notice", "Loading classroom board…"));
  void (async () => {
    try {
      const profileId = id(teacherBoardRequest);
      if (!(await accountClient.restoreSession()))
        throw new Error("Sign in to the teacher workspace to open this board.");
      teacherEditing = await teacherClient.profile(profileId);
      board = structuredClone(teacherEditing.board);
      draft =
        teacherParameters.get("preview") === "1"
          ? null
          : structuredClone(board);
      storageError = "";
      storageBlocked = false;
      activeBoardId = null;
      render();
    } catch (error) {
      root.replaceChildren(
        el(
          "p",
          "notice error",
          error instanceof Error
            ? error.message
            : "The classroom board could not be loaded.",
        ),
      );
      const back = el("a", "button", "Open teacher workspace");
      back.href = "/teacher";
      root.append(back);
    }
  })();
} else {
  classroomSync = createClassroomSync({
    storage: {
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: (key) => localStorage.removeItem(key),
    },
    hasStoredBoard,
    serverHint: document.cookie
      .split(";")
      .some((value) => value.trim() === "sayboard_classroom=1"),
    canApply: () =>
      !storageBlocked &&
      draft === null &&
      arrangement === null &&
      selected === null &&
      !typedMessagePending &&
      heldPointers.size === 0 &&
      Date.now() - lastInteraction >= 2000 &&
      !document.querySelector("dialog[open]"),
    apply: (publication) => {
      if (!publication.board) return false;
      try {
        saveStoredBoard(localStorage, publication.board);
        board = structuredClone(publication.board);
        hasStoredBoard = true;
        storageError = "";
        render();
        status(`Classroom board updated to version ${publication.version}.`);
        return true;
      } catch {
        return false;
      }
    },
    onState: (state) => {
      classroomSyncState = state;
      const indicator = document.querySelector<HTMLElement>(
        ".classroom-sync-status",
      );
      if (indicator) {
        indicator.hidden = state.kind === "unlinked";
        indicator.textContent = syncDescription();
      }
    },
  });
  render();
}

function syncDescription() {
  const state = classroomSyncState;
  if (state.kind !== "linked") return "";
  if (state.status === "offline")
    return "Classroom offline · using saved board";
  if (state.status === "storage-error")
    return "Update could not be saved · current board kept";
  if (state.status === "waiting" && state.publishedVersion)
    return `Classroom update ready · waiting for a pause`;
  return state.version
    ? `Classroom version ${state.version} · automatic updates`
    : "Classroom connected · automatic updates";
}
