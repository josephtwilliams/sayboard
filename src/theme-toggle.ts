import { loadTheme, applyTheme, themeKey } from "./theme";
import { createButton } from "./dom";
import { renderSymbol } from "./symbols";

document.documentElement.dataset.theme = loadTheme();

function updateButtons() {
  const dark = document.documentElement.dataset.theme === "dark";
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    ".workspace-theme-toggle",
  )) {
    const label = dark ? "Switch to light mode" : "Switch to dark mode";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.replaceChildren(renderSymbol(dark ? "sun" : "moon"));
  }
}

window.addEventListener("storage", (event) => {
  if (event.key !== themeKey) return;
  document.documentElement.dataset.theme = loadTheme();
  updateButtons();
});

export function createThemeToggle(): HTMLButtonElement {
  const button = createButton(
    "",
    () => {
      applyTheme(
        document.documentElement.dataset.theme === "dark" ? "light" : "dark",
      );
      updateButtons();
    },
    "button quiet icon-button workspace-theme-toggle",
  );
  const dark = document.documentElement.dataset.theme === "dark";
  const label = dark ? "Switch to light mode" : "Switch to dark mode";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(renderSymbol(dark ? "sun" : "moon"));
  return button;
}
