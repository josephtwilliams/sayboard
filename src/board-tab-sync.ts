import { parseBoard, type Board } from "./board";
import { currentBoardKey } from "./board-storage";

/** Follow cross-tab saves without interrupting communication or reviving old events. */
export function createBoardTabSync({
  storage,
  currentValue,
  canApply,
  apply,
}: {
  storage: Pick<Storage, "getItem">;
  currentValue: () => string | null;
  canApply: () => boolean;
  apply: (board: Board, value: string) => void;
}) {
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function cancel() {
    pending = false;
    clearTimeout(timer);
  }
  function check() {
    clearTimeout(timer);
    if (!pending) return;
    if (!canApply()) {
      timer = setTimeout(check, 500);
      return;
    }
    cancel();
    try {
      // Event values are queued snapshots. A local publication or another tab
      // may have superseded the event before delivery or while communication ran.
      const current = storage.getItem(currentBoardKey);
      if (current === null || current === currentValue()) return;
      apply(parseBoard(JSON.parse(current)), current);
    } catch {
      // Invalid or inaccessible storage must not replace the working board.
    }
  }
  return {
    changed(event: Pick<StorageEvent, "key" | "newValue">) {
      if (event.key !== currentBoardKey || event.newValue === null) return;
      pending = true;
      check();
    },
    // A successful local save/publication supersedes any deferred external save.
    cancel,
  };
}
