# review

A small, fast review interface for work proposed by
[cgwalters-bot](https://github.com/cgwalters-bot) (and by people): a
prioritized queue of questions and actions, forge draft PRs with their diffs
and commit messages, in-place rewording, DCO sign-off as yourself, and
`/promote`. It works against GitHub and against a Forgejo instance.

The rule it is built around: **the forge, git and markdown are the source
of truth**, and the app keeps no database of its own. The queue is the
Workstream board and its issues; answers and edits are made as you, on the
forge. It is two thin client-side apps (GitHub and Forgejo), served
tailnet-only, plus a stateless token relay that GitHub's OAuth requires.

Status: v0 of the GitHub app. Read [docs/design.md](docs/design.md),
starting with its revision at the top: for now the backend is the
Workstream board and its issues, not an items repository. The earlier
claude.ai-hosted prototype, and why it is being replaced, is described in
[docs/prior-prototype.md](docs/prior-prototype.md).

## What v0 does

One ranked queue of everything waiting on you: the bot's open draft PRs
in cgwalters-forge that you haven't approved or sent back at their
current head, and the Workstream board's "Needs human" items (questions,
and other actions) and Draft items (gists to read). P0 comes first
(the board's Priority; a PR takes its board item's), then the oldest.
Questions you answered, or the bot closed, move to the end until the bot
acts. A question is nested under the item it blocks when that is in the
queue too.

- **A forge PR** opens a review pane: the description (without bot-pr's
  meta section), CI checks, every commit with its full message, and the
  diff. **Approve** submits an approving review of the head you were
  shown, which is what `bot-pr promote` acts on; if the head moved
  meanwhile, nothing is sent, and the confirmation names the files you
  never expanded. A
  checkbox adds the `/draft` line that asks promote for a draft upstream
  PR. **Request changes** and **Comment** submit reviews with your text.
- **The diff** is unified or split (remembered per browser), syntax
  colored, with word-level changes marked and the unchanged lines
  between hunks expandable from the file at the head. A file tree gives
  each file's counts; "Viewed" marks are kept per file version, so they
  clear when the file changes; generated, vendored and lock files and
  test fixtures start collapsed. You can view one commit, or a range of
  them, instead of the whole PR. Clicking a line number (or `c` on the
  focused line) writes a line comment, shift-click a range; comments wait
  in the form and go out with your review, those written on an earlier
  commit viewed alone in a comment-only review of that commit.
- **A board item** shows its Why, links, description, gist and latest
  comments, rendered from markdown and sanitized. A parent issue in
  cgwalters-forge/tracker also shows its sub-issues and their progress.
- **A question** is an issue in cgwalters-forge/tracker labelled
  `question`. You answer with a tap on one of the options it offers (the
  recommended one is A), free text, or both; the answer is a plain
  comment by you on that issue, whose first line is the letter you
  picked. The bot acts on it and closes the issue. Upstream issues and
  PRs are never answered from here: they link to GitHub, and the bot's
  questions about them are tracker issues.

The **news** pane (`n`) lists recently merged PRs in the bot
(cgwalters-bot/homegit), its runner (cgwalters-devspace-sandbox, both
copies) and this app, newest first, with the first paragraph of each
description. Harness changes stand out: PRs labeled `harness`, or
touching `agent.yml`, `bot-harness` or a `harness/` tree.

Keys: `j`/`k` move, `o` opens, `u` goes back, `r` reloads; in a PR,
`n`/`p` step through files and `j`/`k` through hunks, `v` marks a file
viewed, `x` folds one, `s` switches unified and split, `[`/`]` step
through the commits, `c` comments on the focused line (or jumps
to the review text), `a` approves (after a confirmation); `?` lists
them. Your text never goes out with a line the bot would read as a
command (`/promote`, `/draft`, `/ready`).

The board is polled every 30 seconds with ETags while the tab is
visible, the forge's PR search every minute, and a PR's reviews only
when it changed.

The app contains no data: everything is fetched in your browser with your
token, from `api.github.com` only.

## Development

Builds and tests need Node.js 22.18 or later (TypeScript runs directly
through Node's type stripping):

```sh
npm ci
npm run check    # tsc, the unit tests, and a build into dist/
npm run dev      # serves http://127.0.0.1:8787/
```

## Hosting and sign-in

The app is published on GitHub Pages at
<https://cgwalters-forge.github.io/review/> by the `pages` workflow, on
every push to main. Until the sign-in relay exists (see "Hosting v0" in
[docs/design.md](docs/design.md)), you sign in by pasting a personal
access token. It stays in your browser (sessionStorage, or localStorage
if you tick "remember") and is sent only to `api.github.com`. The sign-in
page lists the scopes a token needs:

- a short-lived classic token with `public_repo` and `read:project`
  covers everything (`repo` instead, to see private repositories);
- a fine-grained token acts on one resource owner only: owned by
  cgwalters-forge, with Pull requests and Issues read and write, it
  reviews forge PRs and answers questions in the tracker.

The answers and reviews it posts are real, so test against throwaway
items.
