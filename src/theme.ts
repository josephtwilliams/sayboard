export type Theme = "light" | "dark";
export const themeKey = "sayboard-theme";
/** Theme belongs to this device, not exported vocabulary. */
export function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem(themeKey);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* Storage may be disabled. Use device preference for this session. */
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
export function applyTheme(theme: Theme): boolean {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(themeKey, theme);
    return true;
  } catch {
    return false;
  }
}
