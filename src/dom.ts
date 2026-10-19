export function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

export function createButton(
  label: string,
  run: (event: MouseEvent) => void,
  className = "button",
): HTMLButtonElement {
  const element = createElement("button", className, label);
  element.type = "button";
  element.onclick = run;
  return element;
}
