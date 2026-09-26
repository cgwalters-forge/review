// Minimal DOM building. Text always goes in as text nodes and attributes
// through setAttribute; there is no HTML-string path here at all.

export type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

/** An https URL, or undefined: URLs from board fields are untrusted too. */
export function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** An external link that opens in a new tab, or plain text if the URL is unsafe. */
export function link(url: string | undefined, text: string): Node {
  const href = safeHref(url);
  if (!href) return document.createTextNode(text);
  return h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);
}

/** Nodes and strings, without the nulls left by conditionals. */
export function kids(...children: Child[]): (Node | string)[] {
  return children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false);
}

/** Scroll an element into view where the browser can (jsdom can't). */
export function scrollTo(el: Element, block: ScrollLogicalPosition): void {
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block });
}
