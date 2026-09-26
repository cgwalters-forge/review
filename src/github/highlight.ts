// Syntax highlighting for diffs with highlight.js, bundled into app.js
// (the CSP allows no third-party scripts) with the languages the bot's
// repositories use. highlight.js returns HTML; we never insert it.
// Instead a strict reader turns its output (only `<span class="...">`,
// `</span>` and escaped text) back into text segments with classes,
// and the view builds text nodes from those. Output it doesn't expect
// makes it fall back to plain text.

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";
import type { HLJSApi, Language } from "highlight.js";
import type { Span } from "./diff.ts";

/** Nushell: enough to tell keywords, strings, comments and variables apart. */
function nu(api: HLJSApi): Language {
  return {
    name: "Nushell",
    keywords: {
      keyword: "def def-env export export-env extern module use let let-env mut const if else match for in while loop break continue return try catch do where each par-each overlay source source-env alias hide error",
      literal: "true false null",
      built_in: "echo print open save ls cd get select reject update insert upsert append prepend length str into from to http run-external complete describe",
    },
    contains: [
      api.HASH_COMMENT_MODE,
      { scope: "string", variants: [api.QUOTE_STRING_MODE, { begin: "'", end: "'" }, { begin: "`", end: "`" }, { begin: /r#+'/, end: /'#+/ }] },
      { scope: "string", begin: /\$"/, end: '"', contains: [{ scope: "subst", begin: /\(/, end: /\)/ }] },
      { scope: "variable", begin: /\$[A-Za-z_][\w-]*/ },
      { scope: "number", begin: /\b\d+(?:\.\d+)?(?:b|kb|mb|gb|ms|sec|min|hr|day|wk)?\b/ },
      { scope: "operator", begin: /\|/ },
      { scope: "attr", begin: /--?[A-Za-z][\w-]*/ },
    ],
  };
}

/** RPM spec files: preamble tags, sections, macros, comments. */
function rpmSpec(api: HLJSApi): Language {
  return {
    name: "RPM spec",
    contains: [
      api.HASH_COMMENT_MODE,
      { scope: "attribute", begin: /^[A-Za-z][A-Za-z0-9()]*:/, relevance: 0 },
      { scope: "section", begin: /^%(?:prep|build|install|check|clean|files|changelog|description|package|pre|post|preun|postun|pretrans|posttrans|generate_buildrequires|conf|autosetup|setup)\b/ },
      { scope: "keyword", begin: /^%(?:if|ifarch|ifnarch|ifos|else|elif|endif|define|global|undefine|bcond_with|bcond_without|bcond)\b/ },
      { scope: "variable", begin: /%\{[^}\n]*\}|%\??[A-Za-z_]\w*/ },
      api.QUOTE_STRING_MODE,
    ],
  };
}

const LANGUAGES: Record<string, (api: HLJSApi) => Language> = {
  bash, c, dockerfile, go, ini, javascript, json, makefile, markdown, python, rust, typescript, yaml,
  nu, "rpm-spec": rpmSpec,
};
for (const [name, fn] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, fn);

/** Blocks longer than this are shown plain: highlighting them would stall the page. */
export const HIGHLIGHT_MAX_CHARS = 400_000;

/** A run of text with the classes highlight.js gave it (space-separated, possibly empty). */
export interface Seg {
  text: string;
  cls: string;
  /** Part of a word-level change. */
  changed?: boolean;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'" };
const TAG_RE = /<span class="([A-Za-z0-9_ -]*)">|<\/span>|&(amp|lt|gt|quot|#x27|#39);|[<>&]/g;

/**
 * Read highlight.js output back into lines of segments. Returns
 * undefined on anything but its own markup, so a surprise can only cost
 * the colors.
 */
export function readHighlighted(html: string): Seg[][] | undefined {
  const lines: Seg[][] = [[]];
  const stack: string[] = [];
  const emit = (text: string) => {
    const parts = text.split("\n");
    const cls = stack.join(" ");
    parts.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (!p) return;
      const line = lines.at(-1) as Seg[];
      const last = line.at(-1);
      if (last && last.cls === cls) last.text += p;
      else line.push({ text: p, cls });
    });
  };
  let at = 0;
  for (const m of html.matchAll(TAG_RE)) {
    if (m.index > at) emit(html.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] !== undefined) stack.push(m[1]);
    else if (m[0] === "</span>") {
      if (stack.pop() === undefined) return undefined;
    } else if (m[2] !== undefined) emit(ENTITIES[m[2]] as string);
    else return undefined;
  }
  if (at < html.length) emit(html.slice(at));
  return stack.length === 0 ? lines : undefined;
}

const plain = (lines: readonly string[]): Seg[][] => lines.map((t) => (t ? [{ text: t, cls: "" }] : []));

/**
 * Highlight consecutive lines of one file as a block, so strings and
 * comments spanning lines come out right; one segment list per line.
 * Unknown languages and very large blocks come back plain.
 */
export function highlightLines(lang: string | undefined, lines: readonly string[]): Seg[][] {
  if (!lang || !hljs.getLanguage(lang)) return plain(lines);
  const code = lines.join("\n");
  if (code.length > HIGHLIGHT_MAX_CHARS) return plain(lines);
  let out: Seg[][] | undefined;
  try {
    out = readHighlighted(hljs.highlight(code, { language: lang, ignoreIllegals: true }).value);
  } catch {
    out = undefined;
  }
  return out && out.length === lines.length ? out : plain(lines);
}

/** Split segments at the given spans' edges and mark what they cover as changed. */
export function overlay(segs: readonly Seg[], spans: readonly Span[]): Seg[] {
  if (spans.length === 0) return [...segs];
  const out: Seg[] = [];
  let off = 0;
  let si = 0;
  for (const seg of segs) {
    let start = 0;
    while (start < seg.text.length) {
      const pos = off + start;
      while (si < spans.length && (spans[si] as Span)[1] <= pos) si++;
      const span = spans[si];
      const inSpan = span !== undefined && span[0] <= pos;
      const limit = span === undefined ? seg.text.length : (inSpan ? span[1] : span[0]) - off;
      const end = Math.min(seg.text.length, limit);
      const piece: Seg = { text: seg.text.slice(start, end), cls: seg.cls };
      if (inSpan) piece.changed = true;
      out.push(piece);
      start = end;
    }
    off += seg.text.length;
  }
  return out;
}
