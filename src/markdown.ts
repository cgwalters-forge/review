// Markdown rendering for untrusted text: issue and PR bodies, comments,
// board fields and gists are all written by others (and the bot's own
// text may quote anyone). Two layers, as docs/design.md asks:
//
// 1. markdown-it with raw HTML off, so any HTML in the source is shown as
//    text, and its default link validation (no javascript:, vbscript:,
//    file:, or data: other than images);
// 2. DOMPurify over the result, with an allowlist of tags, attributes and
//    URL schemes, returning a DocumentFragment so no HTML string ever
//    reaches an innerHTML sink.
//
// Images become plain links: loading them would tell their host when you
// read an item, and the CSP blocks third-party images anyway.

import MarkdownIt from "markdown-it";
import createDOMPurify, { type Config, type WindowLike } from "dompurify";

/** Sources larger than this are cut, with a note, to keep a phone responsive. */
export const MAX_SOURCE_CHARS = 200_000;

const ALLOWED_TAGS = [
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "li", "ol", "p", "pre", "s", "strong", "table", "tbody", "td", "th", "thead",
  "tr", "ul",
];
const ALLOWED_ATTR = ["href", "title", "start"];
// https, http and mailto only; relative links would resolve against this
// app's origin, which is never what an issue author meant.
const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:)/i;

const PURIFY_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOWED_URI_REGEXP,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
} satisfies Config;

function markdownIt(): MarkdownIt {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx];
    if (!token) return "";
    const src = token.attrGet("src") ?? "";
    const alt = token.children?.map((c) => c.content).join("") || "image";
    if (!md.validateLink(src)) return md.utils.escapeHtml(`[${alt}]`);
    return `<a href="${md.utils.escapeHtml(src)}">${md.utils.escapeHtml(`[image: ${alt}]`)}</a>`;
  };
  return md;
}

export type Renderer = (source: string) => DocumentFragment;

/**
 * Make a renderer bound to a window: the browser's, or jsdom's in tests.
 */
export function createRenderer(win: WindowLike): Renderer {
  const md = markdownIt();
  const purify = createDOMPurify(win);
  if (!purify.isSupported) {
    throw new Error("DOMPurify is not supported in this environment; refusing to render untrusted text");
  }
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  return (source: string) => {
    const cut = source.length > MAX_SOURCE_CHARS;
    const text = cut ? `${source.slice(0, MAX_SOURCE_CHARS)}\n\n*(cut: too long to show here)*` : source;
    return purify.sanitize(md.render(text), PURIFY_CONFIG);
  };
}
