import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { highlightLines, overlay, readHighlighted, type Seg } from "../src/github/highlight.ts";

const flat = (lines: Seg[][] | undefined) => lines?.map((l) => l.map((s) => `${s.cls ? `[${s.cls}]` : ""}${s.text}${s.changed ? "*" : ""}`).join("|"));

describe("readHighlighted", () => {
  const cases: [string, string, string[] | undefined][] = [
    ["spans and entities", '<span class="hljs-keyword">fn</span> a &lt;b&gt; &amp;&quot;&#x27;', ["[hljs-keyword]fn| a <b> &\"'"]],
    ["a span across lines", 'x <span class="hljs-comment">/* a\nb */</span>\ny', ["x |[hljs-comment]/* a", "[hljs-comment]b */", "y"]],
    ["nested classes", '<span class="hljs-string">"<span class="hljs-subst">x</span>"</span>', ['[hljs-string]"|[hljs-string hljs-subst]x|[hljs-string]"']],
    ["empty lines", "a\n\nb", ["a", "", "b"]],
    ["another tag", '<img src=x onerror="alert(1)">', undefined],
    ["a quote in the class", '<span class="a" onclick="x">y</span>', undefined],
    ["an unbalanced close", "a</span>", undefined],
    ["an unclosed span", '<span class="a">b', undefined],
    ["a bare ampersand", "a & b", undefined],
  ];
  for (const [name, html, want] of cases) it(name, () => assert.deepEqual(flat(readHighlighted(html)), want));
});

describe("highlightLines", () => {
  it("highlights a block so multi-line comments carry over", () => {
    const out = highlightLines("rust", ["let s = 1; /* a", "still comment */ fn"]);
    assert.equal(out.length, 2);
    assert.ok(out[0]?.some((s) => s.cls.includes("hljs-keyword") && s.text === "let"));
    assert.ok(out[1]?.[0]?.cls.includes("hljs-comment"));
    assert.equal(out.map((l) => l.map((s) => s.text).join("")).join("\n"), "let s = 1; /* a\nstill comment */ fn");
  });

  it("keeps markup in code as text", () => {
    const code = ['let x = "<script>alert(1)</script>";'];
    const out = highlightLines("javascript", code);
    assert.equal(out[0]?.map((s) => s.text).join(""), code[0]);
  });

  const langs = ["rust", "go", "bash", "yaml", "ini", "javascript", "typescript", "python", "markdown", "dockerfile", "nu", "rpm-spec", "c", "json", "makefile"];
  for (const lang of langs) {
    it(`knows ${lang}`, () => {
      const lines = ["# x", "let a = \"b\" # c", ""];
      assert.deepEqual(highlightLines(lang, lines).map((l) => l.map((s) => s.text).join("")), lines);
    });
  }

  it("colors nu and spec keywords", () => {
    assert.ok(highlightLines("nu", ["def main [] { let x = $env.HOME }"])[0]?.some((s) => s.cls.includes("hljs-keyword") && s.text === "def"));
    assert.ok(highlightLines("rpm-spec", ["%build", "Name: bootc"]).flat().some((s) => s.cls.includes("hljs-section")));
  });

  it("leaves unknown languages plain", () => {
    assert.deepEqual(highlightLines(undefined, ["a", ""]), [[{ text: "a", cls: "" }], []]);
    assert.deepEqual(highlightLines("cobol", ["a"]), [[{ text: "a", cls: "" }]]);
  });
});

describe("overlay", () => {
  const segs: Seg[] = [{ text: "let ", cls: "k" }, { text: "foo", cls: "" }, { text: "(a);", cls: "p" }];
  const cases: [string, [number, number][], string][] = [
    ["no spans", [], "[k]let |foo|[p](a);"],
    ["inside one segment", [[5, 6]], "[k]let |f|o*|o|[p](a);"],
    ["across segments", [[2, 9]], "[k]le|[k]t *|foo*|[p](a*|[p]);"],
    ["two spans", [[0, 1], [7, 8]], "[k]l*|[k]et |foo|[p](*|[p]a);"],
  ];
  for (const [name, spans, want] of cases) it(name, () => assert.equal(flat([overlay(segs, spans)])?.[0], want));
});
