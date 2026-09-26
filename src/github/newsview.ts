// The news pane: merged PRs, newest first, harness changes marked.

import { h, link } from "../dom.ts";
import type { Renderer } from "../markdown.ts";
import type { News } from "./news.ts";
import { age, time } from "./view.ts";

export function newsView(news: News | undefined, render: Renderer, now: number = Date.now()): HTMLElement {
  const root = h(
    "main",
    { class: "news" },
    h("p", { class: "summary" }, "Merged PRs among the latest closed in the bot, its runner and this app · harness changes marked · u or n back"),
  );
  if (!news) {
    root.append(h("p", { class: "empty" }, "Loading…"));
    return root;
  }
  for (const w of news.warnings) root.append(h("p", { class: "warn" }, `Couldn't read ${w}`));
  if (news.items.length === 0) root.append(h("p", { class: "empty" }, "Nothing merged recently."));
  for (const n of news.items) {
    root.append(
      h(
        "article",
        { class: `news-item${n.harness ? " harness" : ""}` },
        h(
          "div",
          { class: "sub" },
          n.harness ? h("span", { class: "kind k-harness" }, "harness") : null,
          h("span", { class: "tag" }, `${n.repo}#${n.number} · ${n.author}`),
          h("span", { class: "age", title: `merged ${time(n.mergedAt)}` }, `${age(n.mergedAt, now)} ago`),
        ),
        h("h3", {}, link(n.url, n.title)),
        n.summary ? h("div", { class: "md" }, render(n.summary)) : null,
      ),
    );
  }
  return root;
}
