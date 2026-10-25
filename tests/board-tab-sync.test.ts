import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoardTabSync } from "../src/board-tab-sync";
import { starterBoard, serializeBoard } from "../src/board";
import { currentBoardKey } from "../src/board-storage";

const first = serializeBoard(starterBoard());
const second = serializeBoard({ ...starterBoard(), rate: 1.1 });
const third = serializeBoard({ ...starterBoard(), rate: 1.2 });
function setup() {
  let current = first;
  let stored = first;
  let idle = true;
  const apply = vi.fn((_board, value: string) => {
    current = value;
  });
  const getItem = vi.fn(() => stored);
  const sync = createBoardTabSync({
    storage: { getItem },
    currentValue: () => current,
    canApply: () => idle,
    apply,
  });
  return {
    sync,
    apply,
    getItem,
    idle: (value: boolean) => {
      idle = value;
    },
    stored: (value: string) => {
      stored = value;
    },
    localPublish: (value: string) => {
      current = stored = value;
      sync.cancel();
    },
    changed: (value = second) =>
      sync.changed({ key: currentBoardKey, newValue: value }),
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("cross-tab communication boundary", () => {
  it("does not apply during typing or speech and follows the latest saved board when idle", () => {
    const state = setup();
    state.idle(false);
    state.stored(second);
    state.changed();
    vi.advanceTimersByTime(10_000);
    expect(state.apply).not.toHaveBeenCalled();
    state.stored(third);
    state.changed(third);
    vi.advanceTimersByTime(10_000);
    expect(state.apply).not.toHaveBeenCalled();
    state.idle(true);
    vi.advanceTimersByTime(500);
    expect(state.apply).toHaveBeenCalledOnce();
    expect(state.apply.mock.calls[0][1]).toBe(third);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a queued event delivered after a newer local publication", () => {
    const state = setup();
    state.localPublish(third);
    state.changed(second);
    expect(state.apply).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an update deferred before a newer local publication", () => {
    const state = setup();
    state.idle(false);
    state.stored(second);
    state.changed();
    state.localPublish(third);
    state.idle(true);
    vi.advanceTimersByTime(10_000);
    expect(state.apply).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rereads storage rather than applying a stale event body", () => {
    const state = setup();
    state.stored(third);
    state.changed(second);
    expect(state.apply.mock.calls[0][1]).toBe(third);
  });

  it("keeps the working board for corrupt, removed or inaccessible storage", () => {
    const state = setup();
    state.stored("invalid");
    state.changed();
    state.getItem.mockImplementation(() => {
      throw new Error("Blocked");
    });
    state.changed();
    state.sync.changed({ key: currentBoardKey, newValue: null });
    expect(state.apply).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not schedule unrelated storage keys", () => {
    const state = setup();
    state.sync.changed({ key: "another-key", newValue: second });
    expect(state.getItem).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
