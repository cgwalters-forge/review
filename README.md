# review

A small, fast review interface for work proposed by
[cgwalters-bot](https://github.com/cgwalters-bot) (and by people): a
prioritized queue of questions and actions, forge draft PRs with their diffs
and commit messages, in-place rewording, DCO sign-off as yourself, and
`/promote`. It works against GitHub and against a Forgejo instance.

The rule it is built around: **git and markdown are the source of truth**.
Work items are markdown files with front matter in an ordinary git
repository; answers and edits become commits pushed as you. The app keeps no
database of its own. It is two thin client-side apps (GitHub and Forgejo)
sharing an item-format library, served tailnet-only, plus a stateless
token relay that GitHub's OAuth requires.

Status: design. Read [docs/design.md](docs/design.md). The earlier
claude.ai-hosted prototype, and why it is being replaced, is described in
[docs/prior-prototype.md](docs/prior-prototype.md).
