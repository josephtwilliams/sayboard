import type { Board } from "./board";
import { hasDeviceLayoutChanges, type DeviceLayout } from "./compact-layout";
import { hasBoardChanges } from "./editor-state";
import type { ArrangementSession } from "./board-arranger";

export type PersistOutcome =
  { kind: "failed" } | { kind: "demo-saved" } | { kind: "device-saved" };
type SavedState = {
  board: Board;
  layout: DeviceLayout;
  storageBlocked: boolean;
};
export type PersistRequest = {
  board: Board;
  layout: DeviceLayout;
  replacementAuthorized: boolean;
};
type SessionPorts = {
  readSaved(): SavedState;
  persist(input: PersistRequest): PersistOutcome;
};
type CaregiverView = {
  readonly board: Board;
  readonly draft: Board | null;
  readonly arrangement: ArrangementSession | null;
  readonly layout: Readonly<DeviceLayout>;
};
type TileEdit = {
  apply(): boolean;
  close(): boolean;
};
export interface CaregiverSessions {
  view(): CaregiverView;
  beginEditor(entry: "settings" | "quick"): Board;
  resumeEditor(): Board;
  closeEditor(): void;
  persist(board: Board): boolean;
  beginArrangement(): ArrangementSession;
  replaceDraft(board: Board): void;
  setLayout(layout: DeviceLayout): void;
  isExpanded(name: string): boolean;
  setExpanded(name: string, open: boolean): void;
  hasUnsavedDraft(): boolean;
  saveEditor(board: Board): boolean;
  saveArrangement(session: ArrangementSession): boolean;
  discardEditor(): void;
  cancelArrangement(): void;
  beginTileEdit(input: { board: Board; mode: "draft" | "quick" }): TileEdit;
}

export function createCaregiverSessions(
  ports: SessionPorts,
): CaregiverSessions {
  let draft: Board | null = null;
  let arrangement: ArrangementSession | null = null;
  let layout = { ...ports.readSaved().layout };
  let replacementAuthorizedDraft: Board | null = null;
  const expandedSettings = new Set<string>();

  function persist(board: Board): boolean {
    const outcome = ports.persist({
      board,
      layout,
      replacementAuthorized: board === replacementAuthorizedDraft,
    });
    switch (outcome.kind) {
      case "failed":
        return false;
      case "demo-saved":
        return true;
      case "device-saved":
        replacementAuthorizedDraft = null;
        return true;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  }

  function saveEditor(board: Board): boolean {
    if (!persist(board)) return false;
    draft = null;
    return true;
  }

  return {
    view() {
      return {
        board: arrangement?.board ?? draft ?? ports.readSaved().board,
        draft,
        arrangement,
        layout,
      };
    },
    beginEditor(entry) {
      const saved = ports.readSaved();
      draft = structuredClone(saved.board);
      layout = { ...saved.layout };
      if (entry === "settings") expandedSettings.clear();
      return draft;
    },
    resumeEditor() {
      draft = structuredClone(ports.readSaved().board);
      return draft;
    },
    closeEditor() {
      draft = null;
    },
    persist,
    beginArrangement() {
      const saved = ports.readSaved();
      arrangement = {
        board: structuredClone(saved.board),
        selectedId: null,
        message: "",
      };
      layout = { ...saved.layout };
      return arrangement;
    },
    replaceDraft(board) {
      draft = board;
      replacementAuthorizedDraft = board;
    },
    setLayout(next) {
      layout = next;
    },
    isExpanded(name) {
      return expandedSettings.has(name);
    },
    setExpanded(name, open) {
      if (open) expandedSettings.add(name);
      else expandedSettings.delete(name);
    },
    hasUnsavedDraft() {
      const saved = ports.readSaved();
      return (
        (arrangement !== null &&
          hasBoardChanges(saved.board, arrangement.board)) ||
        (draft !== null &&
          (hasBoardChanges(saved.board, draft) ||
            hasDeviceLayoutChanges(saved.layout, layout) ||
            (saved.storageBlocked && replacementAuthorizedDraft === draft)))
      );
    },
    saveEditor,
    saveArrangement(session) {
      if (!persist(session.board)) return false;
      arrangement = null;
      return true;
    },
    discardEditor() {
      draft = null;
      replacementAuthorizedDraft = null;
    },
    cancelArrangement() {
      arrangement = null;
    },
    beginTileEdit({ board, mode }) {
      let applied = false;
      return {
        apply() {
          applied = true;
          return mode === "draft" || saveEditor(board);
        },
        close() {
          if (mode !== "quick" || applied) return false;
          draft = null;
          return true;
        },
      };
    },
  };
}
