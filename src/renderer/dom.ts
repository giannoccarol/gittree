/** Typed document.getElementById that throws if the element is missing. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id} in the DOM`);
  return element as T;
}

/** Typed querySelector that returns null for optional elements. */
export function queryOptional<T extends Element = HTMLElement>(
  root: ParentNode, selector: string
): T | null {
  return root.querySelector<T>(selector);
}
