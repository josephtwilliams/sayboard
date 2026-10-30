import { describe, expect, it } from "vitest";
import {
  starterBoard,
  serializeBoard,
  parseBoard,
  type Board,
} from "../src/board";
import { arrangeTile } from "../src/board-arrangement";
import { createCaregiverSessions } from "../src/caregiver-session";
import type { DeviceLayout } from "../src/compact-layout";
import { placeTile } from "../src/layout";

function setup() {
  const saved: { board: Board; layout: DeviceLayout; storageBlocked: boolean } =
    {
      board: starterBoard(),
      layout: { columns: 5, size: null },
      storageBlocked: false,
    };
  let storedBoard = serializeBoard(saved.board);
  let storedLayout: DeviceLayout = { ...saved.layout };
  let storedDemo: string | null = null;
  let resource: "device" | "demo" | "teacher" = "device";
  let failWrites = false;
  let failLayoutWrites = false;
  const sessions = createCaregiverSessions({
    readSaved: () => saved,
    persist({ board, layout, replacementAuthorized }) {
      if (failWrites) return { kind: "failed" };
      if (resource === "demo") {
        storedDemo = serializeBoard(board);
        saved.board = board;
        return { kind: "demo-saved" };
      }
      if (
        resource === "teacher" ||
        (saved.storageBlocked && !replacementAuthorized)
      )
        return { kind: "failed" };
      storedBoard = serializeBoard(board);
      saved.board = board;
      saved.layout = { ...layout };
      if (!failLayoutWrites) storedLayout = { ...layout };
      saved.storageBlocked = false;
      return { kind: "device-saved" };
    },
  });
  return {
    sessions,
    saved,
    storedBoard: () => parseBoard(JSON.parse(storedBoard)),
    storedLayout: () => storedLayout,
    storedDemo: () =>
      storedDemo === null ? null : parseBoard(JSON.parse(storedDemo)),
    resource(value: typeof resource) {
      resource = value;
    },
    failLayoutWrites(value: boolean) {
      failLayoutWrites = value;
    },
    failWrites(value: boolean) {
      failWrites = value;
    },
  };
}

function placeWord(board: Board) {
  const result = placeTile(board.tiles, 20, {
    kind: "word",
    id: "new-word",
    label: "New word",
    phrase: "A new phrase",
    icon: "heart",
    tone: "mint",
  });
  if (result.kind !== "placed") throw new Error("Expected an empty slot");
  board.tiles = result.tiles;
}

describe("caregiver sessions", () => {
  it("clones saved contents and layout on each entry", () => {
    const { sessions, saved } = setup();
    const draft = sessions.beginEditor("quick");
    expect(draft).toEqual(saved.board);
    expect(draft).not.toBe(saved.board);
    expect(draft.subBoards[0]).not.toBe(saved.board.subBoards[0]);
    expect(sessions.view().layout).toEqual(saved.layout);
    expect(sessions.view().layout).not.toBe(saved.layout);
    draft.rate = 1.2;
    sessions.setLayout({ columns: 2, size: "small" });
    const arrangement = sessions.beginArrangement();
    expect(arrangement).toEqual({
      board: saved.board,
      selectedId: null,
      message: "",
    });
    expect(arrangement.board).not.toBe(saved.board);
    expect(sessions.view().draft).toBe(draft);
    expect(sessions.view().board).toBe(arrangement.board);
    expect(sessions.view().layout).toEqual(saved.layout);
    expect(sessions.beginEditor("settings")).toEqual(saved.board);
    expect(sessions.view().arrangement).toBe(arrangement);
    expect(saved.board.rate).toBe(0.85);
  });

  it("tracks semantic board edits, undo, and pending layout independently", () => {
    const { sessions, saved } = setup();
    expect(sessions.hasUnsavedDraft()).toBe(false);
    const draft = sessions.beginEditor("settings");
    expect(sessions.hasUnsavedDraft()).toBe(false);
    draft.subBoards[0].tiles.reverse();
    expect(sessions.hasUnsavedDraft()).toBe(true);
    draft.subBoards[0].tiles.reverse();
    expect(sessions.hasUnsavedDraft()).toBe(false);
    sessions.setLayout({ columns: 2, size: "small" });
    expect(sessions.hasUnsavedDraft()).toBe(true);
    sessions.setLayout({ ...saved.layout });
    expect(sessions.hasUnsavedDraft()).toBe(false);
    sessions.discardEditor();
    const arrangement = sessions.beginArrangement();
    sessions.setLayout({ columns: 2, size: "small" });
    expect(sessions.hasUnsavedDraft()).toBe(false);
    arrangement.board.rate = 1.1;
    expect(sessions.hasUnsavedDraft()).toBe(true);
    arrangement.board.rate = saved.board.rate;
    expect(sessions.hasUnsavedDraft()).toBe(false);
  });

  it("resets expansion only on fresh settings entry", () => {
    const { sessions } = setup();
    sessions.beginEditor("settings");
    sessions.setExpanded("Voice", true);
    sessions.setExpanded("Backup", true);
    sessions.setExpanded("Backup", false);
    expect(sessions.isExpanded("Backup")).toBe(false);
    sessions.replaceDraft(starterBoard());
    sessions.discardEditor();
    sessions.beginEditor("quick");
    sessions
      .beginTileEdit({ board: sessions.view().board, mode: "quick" })
      .close();
    sessions.beginArrangement();
    sessions.cancelArrangement();
    expect(sessions.isExpanded("Voice")).toBe(true);
    sessions.beginEditor("settings");
    expect(sessions.isExpanded("Voice")).toBe(false);
  });

  it("authorizes only the exact replacement under corrupt storage", () => {
    const state = setup();
    state.saved.storageBlocked = true;
    const ordinary = state.sessions.beginEditor("settings");
    expect(state.sessions.hasUnsavedDraft()).toBe(false);
    expect(state.sessions.saveEditor(ordinary)).toBe(false);
    const replacement = starterBoard();
    state.sessions.replaceDraft(replacement);
    expect(state.sessions.hasUnsavedDraft()).toBe(true);
    expect(state.sessions.saveEditor(structuredClone(replacement))).toBe(false);
    expect(state.sessions.view().draft).toBe(replacement);
    state.failWrites(true);
    expect(state.sessions.saveEditor(replacement)).toBe(false);
    expect(state.sessions.hasUnsavedDraft()).toBe(true);
    state.failWrites(false);
    expect(state.sessions.saveEditor(replacement)).toBe(true);
    expect(state.saved.board).toBe(replacement);
    expect(state.sessions.view().draft).toBeNull();
    state.saved.storageBlocked = true;
    expect(state.sessions.saveEditor(replacement)).toBe(false);
  });

  it("keeps layout, expansion, and arrangement when replacing the editor", () => {
    const { sessions } = setup();
    const arrangement = sessions.beginArrangement();
    const layout: DeviceLayout = { columns: 2, size: "small" };
    sessions.setLayout(layout);
    sessions.setExpanded("Voice", true);
    const replacement = starterBoard();
    sessions.replaceDraft(replacement);
    expect(sessions.view().draft).toBe(replacement);
    expect(sessions.view().arrangement).toBe(arrangement);
    expect(sessions.view().board).toBe(arrangement.board);
    expect(sessions.view().layout).toEqual(layout);
    expect(sessions.isExpanded("Voice")).toBe(true);
  });

  it("Back clears editor and authority while retaining the other lane and layout", () => {
    const { sessions, saved } = setup();
    const arrangement = sessions.beginArrangement();
    const replacement = starterBoard();
    sessions.replaceDraft(replacement);
    sessions.setLayout({ columns: 2, size: "small" });
    sessions.discardEditor();
    expect(sessions.view().draft).toBeNull();
    expect(sessions.view().arrangement).toBe(arrangement);
    expect(sessions.view().layout).toEqual({ columns: 2, size: "small" });
    saved.storageBlocked = true;
    expect(sessions.saveEditor(replacement)).toBe(false);
  });

  it("unapplied quick close clears only editor and Cancel clears only arrangement", () => {
    const { sessions, saved } = setup();
    const arrangement = sessions.beginArrangement();
    const replacement = starterBoard();
    sessions.replaceDraft(replacement);
    sessions.setLayout({ columns: 2, size: "small" });
    const form = sessions.beginTileEdit({ board: replacement, mode: "quick" });
    expect(form.close()).toBe(true);
    expect(sessions.view().draft).toBeNull();
    expect(sessions.view().arrangement).toBe(arrangement);
    saved.storageBlocked = true;
    expect(sessions.saveEditor(replacement)).toBe(true);
    const next = sessions.beginEditor("quick");
    sessions.cancelArrangement();
    expect(sessions.view().draft).toBe(next);
    expect(sessions.view().arrangement).toBeNull();
    expect(sessions.view().layout).toEqual({ columns: 2, size: "small" });
  });

  it("Cancel preserves the editor's replacement permission and retained layout", () => {
    const state = setup();
    state.sessions.beginArrangement();
    state.sessions.setLayout({ columns: 2, size: "small" });
    state.sessions.discardEditor();
    const replacement = starterBoard();
    state.sessions.replaceDraft(replacement);
    state.saved.storageBlocked = true;
    state.sessions.cancelArrangement();
    expect(state.sessions.view().draft).toBe(replacement);
    expect(state.sessions.hasUnsavedDraft()).toBe(true);
    expect(state.sessions.saveEditor(replacement)).toBe(true);
    expect(state.storedLayout()).toEqual({ columns: 2, size: "small" });
  });

  it("saves a captured old Board with the current layout and clears current editor", () => {
    const state = setup();
    const captured = state.sessions.beginEditor("settings");
    captured.rate = 1.1;
    const arrangement = state.sessions.beginArrangement();
    state.sessions.replaceDraft(starterBoard());
    state.sessions.setLayout({ columns: 2, size: "small" });
    expect(state.sessions.saveEditor(captured)).toBe(true);
    expect(state.storedBoard().rate).toBe(1.1);
    expect(state.storedLayout()).toEqual({ columns: 2, size: "small" });
    expect(state.sessions.view().draft).toBeNull();
    expect(state.sessions.view().arrangement).toBe(arrangement);
    captured.rate = 1.3;
    expect(state.saved.board.rate).toBe(1.3);
    expect(state.storedBoard().rate).toBe(1.1);
  });

  it("saves the captured arrangement's transactional replacement and clears current arrangement", () => {
    const state = setup();
    const captured = state.sessions.beginArrangement();
    const original = captured.board;
    original.tiles.push(null);
    const moved = arrangeTile({
      board: original,
      pageId: null,
      tileId: "starter-0",
      target: { kind: "slot", index: 20 },
    });
    if (moved.kind !== "changed") throw new Error("Expected arrangement move");
    captured.board = moved.board;
    expect(captured.board).not.toBe(original);
    state.sessions.beginArrangement();
    const draft = state.sessions.beginEditor("quick");
    state.sessions.setLayout({ columns: 3, size: "large" });
    state.failWrites(true);
    const current = state.sessions.view().arrangement;
    expect(state.sessions.saveArrangement(captured)).toBe(false);
    expect(state.sessions.view().arrangement).toBe(current);
    state.failWrites(false);
    expect(state.sessions.saveArrangement(captured)).toBe(true);
    expect(state.storedBoard().tiles[0]).toBeNull();
    expect(state.storedBoard().tiles[20]?.id).toBe("starter-0");
    expect(state.saved.board).toBe(captured.board);
    expect(state.storedLayout()).toEqual({ columns: 3, size: "large" });
    expect(state.sessions.view().arrangement).toBeNull();
    expect(state.sessions.view().draft).toBe(draft);
  });

  it("retains the applied quick draft on write failure and dialog close", () => {
    const state = setup();
    const draft = state.sessions.beginEditor("quick");
    const form = state.sessions.beginTileEdit({ board: draft, mode: "quick" });
    placeWord(draft);
    state.failWrites(true);
    expect(form.apply()).toBe(false);
    expect(form.close()).toBe(false);
    expect(state.sessions.view().draft).toBe(draft);
    expect(state.sessions.hasUnsavedDraft()).toBe(true);
    expect(draft.tiles[20]?.id).toBe("new-word");
    expect(state.storedBoard().tiles).toHaveLength(20);
  });

  it("retries the same quick form without duplicating the applied word", () => {
    const state = setup();
    const draft = state.sessions.beginEditor("quick");
    const form = state.sessions.beginTileEdit({ board: draft, mode: "quick" });
    placeWord(draft);
    state.failWrites(true);
    expect(form.apply()).toBe(false);
    placeWord(draft);
    state.failWrites(false);
    expect(form.apply()).toBe(true);
    expect(form.close()).toBe(false);
    expect(state.sessions.view().draft).toBeNull();
    expect(
      state.storedBoard().tiles.filter((tile) => tile?.id === "new-word"),
    ).toHaveLength(1);
  });

  it("keeps applied lifetime local to each modal and completes the current editor", () => {
    const state = setup();
    const old = state.sessions.beginEditor("quick");
    const applied = state.sessions.beginTileEdit({ board: old, mode: "quick" });
    placeWord(old);
    state.failWrites(true);
    expect(applied.apply()).toBe(false);
    const next = state.sessions.beginTileEdit({ board: old, mode: "quick" });
    expect(next.close()).toBe(true);
    state.sessions.beginEditor("settings");
    expect(applied.close()).toBe(false);
    expect(state.sessions.view().draft).not.toBeNull();
    state.failWrites(false);
    expect(applied.apply()).toBe(true);
    expect(state.saved.board).toBe(old);
    expect(state.sessions.view().draft).toBeNull();
  });

  it("applies full-draft forms without persistence or editor completion", () => {
    const state = setup();
    const draft = state.sessions.beginEditor("settings");
    const form = state.sessions.beginTileEdit({ board: draft, mode: "draft" });
    placeWord(draft);
    expect(form.apply()).toBe(true);
    expect(form.close()).toBe(false);
    expect(state.sessions.view().draft).toBe(draft);
    expect(state.sessions.hasUnsavedDraft()).toBe(true);
    expect(state.saved.board).not.toBe(draft);
    expect(state.storedBoard().tiles).toHaveLength(20);
  });

  it("keeps demo replacement authority and pending layout after generic persistence", () => {
    const state = setup();
    state.resource("demo");
    state.saved.storageBlocked = true;
    const arrangement = state.sessions.beginArrangement();
    const replacement = starterBoard();
    replacement.rate = 1.1;
    state.sessions.replaceDraft(replacement);
    state.sessions.setLayout({ columns: 2, size: "small" });
    state.sessions.setExpanded("Backup and transfer", true);
    expect(state.sessions.persist(replacement)).toBe(true);
    expect(state.storedDemo()?.rate).toBe(1.1);
    expect(state.saved.board).toBe(replacement);
    expect(state.saved.storageBlocked).toBe(true);
    expect(state.saved.layout).toEqual({ columns: 5, size: null });
    expect(state.storedLayout()).toEqual({ columns: 5, size: null });
    expect(state.storedBoard().rate).toBe(0.85);
    expect(state.sessions.view().draft).toBe(replacement);
    expect(state.sessions.view().arrangement).toBe(arrangement);
    expect(state.sessions.isExpanded("Backup and transfer")).toBe(true);
    state.resource("device");
    expect(state.sessions.persist(structuredClone(replacement))).toBe(false);
    expect(state.sessions.persist(replacement)).toBe(true);
    expect(state.sessions.view().draft).toBe(replacement);
    expect(state.sessions.view().arrangement).toBe(arrangement);
    expect(state.storedLayout()).toEqual({ columns: 2, size: "small" });
    state.saved.storageBlocked = true;
    expect(state.sessions.persist(replacement)).toBe(false);
  });

  it("completes each saved lane on demo success without consuming authority", () => {
    const state = setup();
    state.resource("demo");
    const arrangement = state.sessions.beginArrangement();
    state.sessions.replaceDraft(arrangement.board);
    state.saved.storageBlocked = true;
    expect(state.sessions.saveArrangement(arrangement)).toBe(true);
    expect(state.sessions.view().arrangement).toBeNull();
    expect(state.sessions.view().draft).toBe(arrangement.board);
    expect(state.sessions.saveEditor(arrangement.board)).toBe(true);
    expect(state.sessions.view().draft).toBeNull();
    state.resource("device");
    expect(state.sessions.persist(arrangement.board)).toBe(true);
  });

  it("retains both lanes and authority on failed demo persistence", () => {
    const state = setup();
    state.resource("demo");
    const arrangement = state.sessions.beginArrangement();
    state.sessions.replaceDraft(arrangement.board);
    state.failWrites(true);
    expect(state.sessions.saveEditor(arrangement.board)).toBe(false);
    expect(state.sessions.saveArrangement(arrangement)).toBe(false);
    expect(state.sessions.view().draft).toBe(arrangement.board);
    expect(state.sessions.view().arrangement).toBe(arrangement);
    expect(state.storedDemo()).toBeNull();
    state.failWrites(false);
    state.resource("device");
    state.saved.storageBlocked = true;
    expect(state.sessions.persist(arrangement.board)).toBe(true);
  });

  it("counts a device layout warning as success and consumes replacement authority", () => {
    const state = setup();
    const replacement = starterBoard();
    replacement.rate = 1.1;
    state.sessions.replaceDraft(replacement);
    state.sessions.setLayout({ columns: 2, size: "small" });
    state.saved.storageBlocked = true;
    state.failLayoutWrites(true);
    expect(state.sessions.saveEditor(replacement)).toBe(true);
    expect(state.sessions.view().draft).toBeNull();
    expect(state.saved.board).toBe(replacement);
    expect(state.storedBoard().rate).toBe(1.1);
    expect(state.saved.storageBlocked).toBe(false);
    expect(state.saved.layout).toEqual({ columns: 2, size: "small" });
    expect(state.storedLayout()).toEqual({ columns: 5, size: null });
    state.saved.storageBlocked = true;
    expect(state.sessions.persist(replacement)).toBe(false);
  });

  it("resumes a distinct saved clone after teacher save while retaining pending state and old authority", () => {
    const state = setup();
    state.resource("teacher");
    const captured = state.sessions.resumeEditor();
    const arrangement = state.sessions.beginArrangement();
    const replacement = starterBoard();
    state.sessions.replaceDraft(replacement);
    state.sessions.setLayout({ columns: 2, size: "small" });
    state.sessions.setExpanded("Voice", true);
    const serverBoard = starterBoard();
    serverBoard.rate = 1.3;
    state.saved.board = structuredClone(serverBoard);
    const resumed = state.sessions.resumeEditor();
    expect(resumed.rate).toBe(1.3);
    expect(resumed).toBe(state.sessions.view().draft);
    expect(resumed).not.toBe(state.saved.board);
    expect(resumed).not.toBe(serverBoard);
    expect(resumed).not.toBe(captured);
    expect(resumed.subBoards[0]).not.toBe(state.saved.board.subBoards[0]);
    expect(state.sessions.view().arrangement).toBe(arrangement);
    expect(state.sessions.view().layout).toEqual({ columns: 2, size: "small" });
    expect(state.sessions.isExpanded("Voice")).toBe(true);
    state.resource("device");
    state.saved.storageBlocked = true;
    expect(state.sessions.persist(resumed)).toBe(false);
    expect(state.sessions.persist(structuredClone(replacement))).toBe(false);
    expect(state.sessions.persist(replacement)).toBe(true);
    expect(state.sessions.view().draft).toBe(resumed);
    expect(state.storedLayout()).toEqual({ columns: 2, size: "small" });
  });

  it("resumes without authorizing a replacement or resetting layout and expansion", () => {
    const state = setup();
    state.saved.storageBlocked = true;
    state.sessions.setLayout({ columns: 2, size: "small" });
    state.sessions.setExpanded("Backup and transfer", true);
    const draft = state.sessions.resumeEditor();
    expect(state.sessions.persist(draft)).toBe(false);
    expect(state.sessions.view().draft).toBe(draft);
    expect(state.sessions.view().layout).toEqual({ columns: 2, size: "small" });
    expect(state.sessions.isExpanded("Backup and transfer")).toBe(true);
  });

  it("closes only the editor while discard also revokes replacement authority", () => {
    const state = setup();
    const arrangement = state.sessions.beginArrangement();
    const replacement = starterBoard();
    state.sessions.replaceDraft(replacement);
    state.sessions.setLayout({ columns: 2, size: "small" });
    state.sessions.setExpanded("Voice", true);
    state.saved.storageBlocked = true;
    state.sessions.closeEditor();
    expect(state.sessions.view().draft).toBeNull();
    expect(state.sessions.view().arrangement).toBe(arrangement);
    expect(state.sessions.view().layout).toEqual({ columns: 2, size: "small" });
    expect(state.sessions.isExpanded("Voice")).toBe(true);
    expect(state.sessions.persist(replacement)).toBe(true);
    state.sessions.replaceDraft(replacement);
    state.saved.storageBlocked = true;
    state.sessions.discardEditor();
    expect(state.sessions.persist(replacement)).toBe(false);
    expect(state.sessions.view().arrangement).toBe(arrangement);
    expect(state.sessions.isExpanded("Voice")).toBe(true);
  });

  it("preserves pending state when a teacher resource rejects device saves", () => {
    const state = setup();
    state.resource("teacher");
    const arrangement = state.sessions.beginArrangement();
    const replacement = starterBoard();
    state.sessions.replaceDraft(replacement);
    state.sessions.setLayout({ columns: 2, size: "small" });
    state.sessions.setExpanded("Voice", true);
    expect(state.sessions.persist(replacement)).toBe(false);
    expect(state.sessions.saveEditor(replacement)).toBe(false);
    expect(state.sessions.saveArrangement(arrangement)).toBe(false);
    expect(state.sessions.view().draft).toBe(replacement);
    expect(state.sessions.view().arrangement).toBe(arrangement);
    expect(state.sessions.view().layout).toEqual({ columns: 2, size: "small" });
    expect(state.sessions.isExpanded("Voice")).toBe(true);
    expect(state.saved.board).not.toBe(replacement);
    state.resource("device");
    state.saved.storageBlocked = true;
    expect(state.sessions.persist(replacement)).toBe(true);
  });

  it("includes a delayed replacement's dirty state while an arrangement is clean", () => {
    const { sessions } = setup();
    sessions.beginArrangement();
    expect(sessions.hasUnsavedDraft()).toBe(false);
    const replacement = starterBoard();
    replacement.rate = 1.1;
    sessions.replaceDraft(replacement);
    expect(sessions.hasUnsavedDraft()).toBe(true);
    sessions.cancelArrangement();
    expect(sessions.hasUnsavedDraft()).toBe(true);
    sessions.discardEditor();
    expect(sessions.hasUnsavedDraft()).toBe(false);
  });

  it("lets a sync caller read current membership even when both lanes are clean", () => {
    const { sessions } = setup();
    const canApply = () => {
      const { draft, arrangement } = sessions.view();
      return draft === null && arrangement === null;
    };
    expect(canApply()).toBe(true);
    sessions.resumeEditor();
    expect(sessions.hasUnsavedDraft()).toBe(false);
    expect(canApply()).toBe(false);
    sessions.beginArrangement();
    sessions.closeEditor();
    expect(sessions.hasUnsavedDraft()).toBe(false);
    expect(canApply()).toBe(false);
    sessions.cancelArrangement();
    expect(canApply()).toBe(true);
    sessions.beginEditor("quick");
    expect(canApply()).toBe(false);
    sessions.discardEditor();
    expect(canApply()).toBe(true);
  });
});
