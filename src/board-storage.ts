import { parseBoard, serializeBoard, type Board } from "./board";
export { serializeBoard } from "./board";

export const currentBoardKey = "sayboard-v2";
export const legacyBoardKey = "sayboard-v1";
export const recoveryBoardKey = "sayboard-recovery-before-categories";

type BoardStorage = Pick<Storage, "getItem" | "setItem">;
export type LoadedBoard =
  | { kind: "loaded"; board: Board; migrated: boolean }
  | { kind: "empty" }
  | { kind: "unavailable"; message: string };

/** Read the new key first; a corrupt current copy must never revive an older board. */
export function loadStoredBoard(storage: BoardStorage): LoadedBoard {
  try {
    const current = storage.getItem(currentBoardKey);
    if (current !== null)
      return {
        kind: "loaded",
        board: parseBoard(JSON.parse(current)),
        migrated: false,
      };
    const legacy = storage.getItem(legacyBoardKey);
    if (legacy !== null)
      return {
        kind: "loaded",
        board: parseBoard(JSON.parse(legacy)),
        migrated: true,
      };
    return { kind: "empty" };
  } catch {
    return {
      kind: "unavailable",
      message:
        "Saved board could not be loaded. Its original data is retained. Import a backup or explicitly reset the draft before saving a replacement.",
    };
  }
}

/** Never mutate the original version-1 entry. Preserve an unreadable v2 copy before replacement. */
export function saveStoredBoard(storage: BoardStorage, board: Board): string {
  const serialized = serializeBoard(board);
  const current = storage.getItem(currentBoardKey);
  if (current !== null) {
    try {
      parseBoard(JSON.parse(current));
    } catch {
      storage.setItem(recoveryBoardKey, current);
    }
  }
  storage.setItem(currentBoardKey, serialized);
  return serialized;
}
