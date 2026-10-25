import { createElement as el } from "./dom";
import {
  loadStoredBoard,
  currentBoardKey,
  legacyBoardKey,
  recoveryBoardKey,
} from "./board-storage";
import { serializeBoard } from "./board";
import "./style.css";
import "./teacher.css";

const root = document.querySelector("#move-board");
if (!root) throw new Error("Missing board recovery page");
const main = el("main", "teacher-shell");
main.append(
  el("h1", "", "Take your board to sayboard.org"),
  el(
    "p",
    "teacher-intro",
    "Browser boards belong to a website address. This page helps you export a board saved at the old Vercel address. Your saved data stays here until you choose to clear it.",
  ),
);
const card = el("section", "teacher-card");
if (location.hostname !== "sayboard.vercel.app") {
  card.append(el("h2", "", "Open the old address to recover its board"));
  const back = el(
    "a",
    "button primary",
    "Recover a board from the old address",
  );
  back.href = "https://sayboard.vercel.app/move-board.html";
  card.append(back);
} else {
  try {
    const board = loadStoredBoard(localStorage);
    if (board.kind === "loaded") {
      const download = el("a", "button primary", "Download my board");
      download.href = URL.createObjectURL(
        new Blob([serializeBoard(board.board)], { type: "application/json" }),
      );
      download.download = "sayboard-board.json";
      card.append(el("h2", "", "Your saved board is here"), download);
    } else if (board.kind === "unavailable") {
      card.append(
        el("h2", "", "Keep a recovery copy"),
        el(
          "p",
          "",
          "The saved board could not be read. Download the original data so it can be recovered without replacing it.",
        ),
      );
      for (const key of [currentBoardKey, legacyBoardKey, recoveryBoardKey]) {
        const raw = localStorage.getItem(key);
        if (raw === null) continue;
        const download = el("a", "button", `Download ${key} recovery data`);
        download.href = URL.createObjectURL(
          new Blob([raw], { type: "application/json" }),
        );
        download.download = `${key}-recovery.json`;
        card.append(download);
      }
    } else
      card.append(
        el("h2", "", "No saved board in this browser"),
        el(
          "p",
          "",
          "Try the browser and device you used before. This page does not upload or delete anything.",
        ),
      );
  } catch {
    card.append(
      el(
        "p",
        "",
        "Browser storage is blocked. Open this page in the browser and profile where the board was saved.",
      ),
    );
  }
}
card.append(
  el(
    "p",
    "",
    "After downloading, open sayboard.org, enter caregiver controls, choose Edit board and settings, and use Import board under Backup and transfer. Review the draft and Save board.",
  ),
);
const next = el("a", "button", "Continue to sayboard.org");
next.href = "https://sayboard.org/";
card.append(next);
main.append(card);
root.append(main);
