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

It lists the Workstream board's "Needs human" items by priority. An item
shows its Why, links, description, gist and latest comments, rendered
from markdown and sanitized. You answer with a tap on one of the options
the bot offered (parsed from Why), free text, or both. On an issue or PR
the answer is a comment by you starting with `/answer` (or `/answer B`);
on a draft item it is a receipt gist plus a marked section in the draft
body, both readable by anyone while the board is public. The queue is polled every 30 seconds with ETags while the tab
is visible.

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

On a loopback address (127.0.0.1, localhost) with no sign-in relay
behind it, the app is in development mode and asks for a token, which it
keeps in the tab's sessionStorage. On any other origin it never asks for
one. Use a token made for testing:

- a fine-grained token (resource owner: you, expiring soon) with Issues
  read and write, Pull requests read, Metadata read and the account
  permission Gists read and write. That reads the public board and
  answers issues and PRs, but can't write drafts on a board owned by
  another user;
- only if you need to test draft answers: a short-lived classic token
  with `repo`, `project` and `gist`, which also needs you to be able to
  edit the board.

The answers it posts are real, so point it at test items or be ready to
delete them. The board is public: a draft answer, and the link to its
receipt gist, can be read by anyone.
