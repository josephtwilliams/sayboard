import { createElement as el, createButton as button } from "./dom";
import {
  boardPage,
  parseBoard,
  removeTile,
  type Board,
  type Tile,
} from "./board";
import { arrangeTile } from "./board-arrangement";
import { renderSymbol } from "./symbols";
import { createSymbolPicker } from "./symbol-picker";
import { showDismissibleModal } from "./modal";
import "./direct-board-editor.css";
import "./picker.css";

/** A visual draft editor. All edits stay local until its caller saves the draft. */
export function createDirectBoardEditor({
  board,
  onChange,
  confirm,
}: {
  board: Board;
  onChange: (board: Board, message: string) => void;
  confirm: (message: string) => Promise<boolean>;
}): HTMLElement {
  let working = structuredClone(board);
  let pageId: string | null = null;
  let message =
    "Click a tile to edit. Drag tiles to move or swap them. Use the Move button on touchscreens or with a keyboard.";
  let drag: {
    tileId: string;
    pointerId: number;
    x: number;
    y: number;
    started: boolean;
    handle: HTMLButtonElement;
  } | null = null;
  let highlighted: HTMLElement | null = null;
  let suppressClick = false;
  const section = el("section", "direct-board-editor");
  section.setAttribute("aria-label", "Edit board visually");

  function clearDrag() {
    const previous = drag;
    drag = null;
    if (previous?.handle.hasPointerCapture(previous.pointerId))
      previous.handle.releasePointerCapture(previous.pointerId);
    highlighted?.classList.remove("direct-drop-active");
    highlighted = null;
    section.classList.remove("direct-dragging");
  }
  function change(next: Board, detail: string, focusId?: string) {
    working = parseBoard(next);
    message = detail;
    onChange(working, detail);
    render();
    if (focusId) {
      Array.from(
        section.querySelectorAll<HTMLButtonElement>("[data-direct-tile]"),
      )
        .find((node) => node.dataset.directTile === focusId)
        ?.focus({ preventScroll: true });
    }
  }
  function move(tileId: string, index: number) {
    const next = structuredClone(working);
    const page = boardPage(next, pageId);
    while (page.tiles.length <= index) page.tiles.push(null);
    const result = arrangeTile({
      board: next,
      pageId,
      tileId,
      target: { kind: "slot", index },
    });
    if (result.kind === "changed") change(result.board, result.message, tileId);
    else {
      message = result.message;
      render();
    }
  }
  function moveDialog(tile: Tile) {
    const dialog = el("dialog", "tile-dialog direct-dialog");
    const heading = el("h2", "", `Move ${tile.label}`);
    heading.id = "direct-move-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    const label = el("label", "", "Destination slot");
    const select = el("select");
    select.setAttribute("aria-label", "Destination slot");
    const page = boardPage(working, pageId);
    const count = Math.min(
      60,
      Math.max(20, Math.ceil((page.tiles.length + 1) / 5) * 5),
    );
    for (let index = 0; index < count; index++)
      select.append(
        new Option(
          `Slot ${index + 1}: ${page.tiles[index]?.label ?? "empty"}`,
          String(index),
        ),
      );
    select.value = String(
      page.tiles.findIndex((value) => value?.id === tile.id),
    );
    label.append(select);
    const actions = el("div", "dialog-actions");
    actions.append(
      button("Cancel", () => dialog.close()),
      button(
        "Move tile",
        () => {
          const target = Number(select.value);
          dialog.close();
          move(tile.id, target);
        },
        "button primary",
      ),
    );
    dialog.append(heading, label, actions);
    showDismissibleModal(dialog);
    select.focus();
  }
  function edit(index: number, kind: Tile["kind"] = "word") {
    const current = boardPage(working, pageId).tiles[index];
    const category =
      current?.kind === "category" || (!current && kind === "category");
    const dialog = el("dialog", "tile-dialog word-dialog direct-dialog");
    const heading = el(
      "h2",
      "",
      current
        ? `Edit ${current.label}`
        : category
          ? "Add category"
          : "Add word or phrase",
    );
    heading.id = "direct-edit-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    const form = el("form");
    const fields = el("div", "word-fields");
    const nameLabel = el(
      "label",
      "",
      category ? "Category name" : "Text on the tile",
    );
    const name = el("input");
    name.value = current?.label ?? "";
    name.maxLength = 40;
    name.required = true;
    nameLabel.append(name);
    const phraseLabel = el("label", "", "Text to speak");
    const phrase = el("input");
    phrase.value = current?.phrase ?? "";
    phrase.maxLength = 200;
    phrase.required = !category;
    phraseLabel.append(phrase);
    fields.append(nameLabel);
    if (!category) fields.append(phraseLabel);
    const toneLabel = el("label", "", "Tile colour");
    const tone = el("select");
    for (const [value, label] of [
      ["mint", "Green"],
      ["peach", "Peach"],
      ["blue", "Blue"],
      ["lavender", "Lavender"],
    ])
      tone.append(new Option(label, value));
    tone.value = current?.tone ?? "mint";
    toneLabel.append(tone);
    fields.append(toneLabel);
    const picker = createSymbolPicker({
      initialId: current?.icon ?? (category ? "book-open" : "message-circle"),
      text: current?.label ?? "",
      explicit: Boolean(current),
    });
    let customPhrase = Boolean(current && current.phrase !== current.label);
    phrase.oninput = () => {
      customPhrase = true;
    };
    name.oninput = () => {
      if (!customPhrase) phrase.value = name.value;
      picker.updateSuggestions(name.value);
    };
    const error = el("p", "notice error");
    error.hidden = true;
    error.role = "alert";
    const actions = el("div", "dialog-actions");
    actions.append(button("Cancel", () => dialog.close()));
    if (current)
      actions.append(
        button(
          "Delete tile",
          () =>
            void (async () => {
              if (
                !(await confirm(
                  category
                    ? `Delete ${current.label} and its category words from this draft?`
                    : `Delete ${current.label} from this draft?`,
                ))
              )
                return;
              const next = structuredClone(working);
              removeTile(next, boardPage(next, pageId), index);
              dialog.close();
              change(next, `${current.label} removed from the draft.`);
            })(),
          "button quiet",
        ),
      );
    const submit = el("button", "button primary", "Apply changes");
    submit.type = "submit";
    actions.append(submit);
    form.append(fields, picker.element, error, actions);
    form.onsubmit = (event) => {
      event.preventDefault();
      try {
        const colour = tone.value;
        if (
          colour !== "mint" &&
          colour !== "peach" &&
          colour !== "blue" &&
          colour !== "lavender"
        )
          throw new Error("Choose a tile colour.");
        const next = structuredClone(working);
        const fields = {
          id: current?.id ?? crypto.randomUUID(),
          label: name.value.trim(),
          phrase: category ? name.value.trim() : phrase.value.trim(),
          icon: picker.selectedId(),
          tone: colour,
        } satisfies Pick<Tile, "id" | "label" | "phrase" | "icon" | "tone">;
        const destination = boardPage(next, pageId);
        while (destination.tiles.length <= index) destination.tiles.push(null);
        if (category) {
          if (pageId !== null)
            throw new Error("Add categories on the Home board.");
          const subBoardId =
            current?.kind === "category"
              ? current.subBoardId
              : crypto.randomUUID();
          destination.tiles[index] = {
            ...fields,
            kind: "category",
            subBoardId,
          };
          if (!current)
            next.subBoards.push({
              id: subBoardId,
              size: destination.size,
              tiles: [null],
            });
        } else destination.tiles[index] = { ...fields, kind: "word" };
        const validated = parseBoard(next);
        dialog.close();
        change(validated, `${fields.label} updated in the draft.`, fields.id);
      } catch (cause) {
        error.hidden = false;
        error.textContent =
          cause instanceof Error
            ? cause.message
            : "The tile could not be updated.";
      }
    };
    dialog.append(heading, form);
    showDismissibleModal(dialog);
    name.focus();
  }
  function wireDrag(handle: HTMLButtonElement, tile: Tile, mouseOnly: boolean) {
    handle.addEventListener("keydown", () => {
      suppressClick = false;
    });
    handle.onpointerdown = (event) => {
      suppressClick = false;
      if (
        event.button !== 0 ||
        !event.isPrimary ||
        (mouseOnly && event.pointerType !== "mouse")
      )
        return;
      clearDrag();
      handle.focus({ preventScroll: true });
      drag = {
        tileId: tile.id,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        started: false,
        handle,
      };
      handle.setPointerCapture(event.pointerId);
    };
    handle.onpointermove = (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (
        !drag.started &&
        Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8
      )
        return;
      drag.started = true;
      section.classList.add("direct-dragging");
      highlighted?.classList.remove("direct-drop-active");
      const hit = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-direct-slot]");
      highlighted = hit && section.contains(hit) ? hit : null;
      highlighted?.classList.add("direct-drop-active");
      const feedback = section.querySelector<HTMLElement>(".direct-feedback");
      if (feedback)
        feedback.textContent = highlighted
          ? `Release to move or swap ${tile.label} with slot ${Number(highlighted.dataset.directSlot) + 1}.`
          : "Release outside the board to cancel.";
      if (event.clientY > innerHeight - 50) window.scrollBy(0, 14);
      else if (event.clientY < 80) window.scrollBy(0, -14);
    };
    handle.onpointerup = (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const previous = drag,
        target = highlighted;
      clearDrag();
      if (!previous.started) return;
      suppressClick = true;
      if (target?.dataset.directSlot !== undefined)
        move(previous.tileId, Number(target.dataset.directSlot));
      else {
        message = "Move cancelled. The draft is unchanged.";
        render();
      }
    };
    handle.onpointercancel = () => {
      clearDrag();
      suppressClick = true;
    };
    handle.onlostpointercapture = () => {
      if (drag) {
        clearDrag();
        suppressClick = true;
      }
    };
  }
  section.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !drag) return;
    event.preventDefault();
    clearDrag();
    suppressClick = true;
    message = "Move cancelled. The draft is unchanged.";
    render();
  });
  function render() {
    const scrollPosition = window.scrollY;
    section.replaceChildren();
    const page = boardPage(working, pageId);
    const localNav = el("div", "direct-navigation");
    const home = button("Home board", () => {
      pageId = null;
      render();
    });
    home.disabled = pageId === null;
    const category = working.tiles.find(
      (value) => value?.kind === "category" && value.subBoardId === pageId,
    );
    localNav.append(home, el("strong", "", category?.label ?? "Home"));
    const tools = el("div", "direct-tools");
    const nextSlot = () => {
      const hole = page.tiles.findIndex((value) => value === null);
      return hole === -1 ? page.tiles.length : hole;
    };
    const add = button("Add word or phrase", () => edit(nextSlot()));
    add.disabled = nextSlot() >= 60;
    tools.append(add);
    if (pageId === null) {
      const addCategory = button("Add category", () =>
        edit(nextSlot(), "category"),
      );
      addCategory.disabled = nextSlot() >= 60;
      tools.append(addCategory);
    }
    const feedback = el("p", "direct-feedback", message);
    feedback.role = "status";
    feedback.setAttribute("aria-live", "polite");
    const grid = el("div", "direct-grid");
    grid.setAttribute("aria-label", "Editable board slots");
    const count = Math.min(
      60,
      Math.max(20, Math.ceil((page.tiles.length + 1) / 5) * 5),
    );
    for (let index = 0; index < count; index++) {
      const tile = page.tiles[index];
      const cell = el(
        "div",
        `direct-cell ${tile ? tile.tone : "direct-empty"}`,
      );
      cell.dataset.directSlot = String(index);
      if (!tile) {
        const add = button("", () => edit(index), "direct-add");
        add.setAttribute("aria-label", `Add word in slot ${index + 1}`);
        add.append(renderSymbol("plus"), el("span", "", "Add word"));
        cell.append(add);
      } else {
        const select = button(
          "",
          () => {
            if (suppressClick) {
              suppressClick = false;
              return;
            }
            if (tile.kind === "category") {
              pageId = tile.subBoardId;
              render();
            } else edit(index);
          },
          "tile direct-edit",
        );
        select.setAttribute(
          "aria-label",
          tile.kind === "category"
            ? `Open ${tile.label} category`
            : `Edit ${tile.label}`,
        );
        select.dataset.directTile = tile.id;
        select.append(renderSymbol(tile.icon), el("span", "", tile.label));
        wireDrag(select, tile, true);
        const moveHandle = button(
          "",
          () => {
            if (suppressClick) {
              suppressClick = false;
              return;
            }
            moveDialog(tile);
          },
          "direct-move",
        );
        moveHandle.setAttribute("aria-label", `Move ${tile.label}`);
        moveHandle.title = "Drag to move, or click for move controls";
        moveHandle.append(renderSymbol("grip-vertical"));
        wireDrag(moveHandle, tile, false);
        cell.append(select, moveHandle);
        if (tile.kind === "category")
          cell.append(
            button("Edit category", () => edit(index), "direct-category-edit"),
          );
      }
      grid.append(cell);
    }
    section.append(localNav, tools, feedback, grid);
    window.scrollTo({ top: scrollPosition, behavior: "instant" });
  }
  render();
  return section;
}
