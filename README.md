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

- **A forge PR** opens a review pane: the description (without bot-pr's
  meta section), CI checks, every commit with its full message, and the
  diff per file, foldable. **Approve** submits an approving review of the
  head you were shown, which is what `bot-pr promote` acts on; if the
  head moved meanwhile, nothing is sent. A checkbox adds the `/draft`
  line that asks promote for a draft upstream PR. **Request changes** and
  **Comment** submit reviews with your text.
- **A board item** shows its Why, links, description, gist and latest
  comments, rendered from markdown and sanitized. You answer with a tap
  on one of the options the bot offered (parsed from Why), free text, or
  both. On an issue or PR the answer is a comment by you starting with
  `/answer` (or `/answer B`); on a draft item it is a receipt gist plus a
  marked section in the draft body, both readable by anyone while the
  board is public.

Keys: `j`/`k` move, `o` opens, `u` goes back, `r` reloads; in a PR,
`j`/`k` step through files, `x` folds one, `a` approves (after a
confirmation) and `c` jumps to the review text; `?` lists them. Your
text never goes out with a line the bot would read as a command
(`/promote`, `/draft`, `/ready`, `/answer`).

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

- a short-lived classic token with `public_repo`, `read:project` and
  `gist` covers everything (`repo` and `project` instead, to see private
  repositories and answer draft items on the board);
- a fine-grained token acts on one resource owner only: owned by
  cgwalters-forge, with Pull requests and Issues read and write, it
  reviews forge PRs but can't answer upstream or on draft items.

The answers and reviews it posts are real, so test against throwaway
items. The board is public: a draft answer, and the link to its receipt
gist, can be read by anyone.
