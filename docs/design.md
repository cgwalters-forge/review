# review: design

Status: proposal, 2026-09-25. Tracks
[cgwalters-bot/cgwalters-bot#8](https://github.com/cgwalters-bot/cgwalters-bot/issues/8).
It builds on the pivot plan's review-workflow part
([gist](https://gist.github.com/cgwalters-bot/17b14e3407e4cb30bda7cb03e58e2481)).
Choices marked **Decision** are recommendations for cgwalters to accept or
overrule. The questions for him are at the end.

## Summary

- **Source of truth.** Work items become markdown files with YAML front matter
  in an ordinary git repository (`items/<slug>.md`, provisionally in
  `cgwalters-forge/workstream`). The app writes answers and field edits as
  commits made as you, through the contents API, which both GitHub and Forgejo
  support with a blob-sha precondition. The bot reads them with `git pull`.
  The Projects v2 board becomes a one-way mirror, then optional. PRs, their
  descriptions and their commits stay where they are: on the forge and in git.
- **Static site?** For Forgejo, yes: its OAuth2 provider accepts public
  clients with PKCE, and the token endpoint honours the instance's `[cors]`
  settings. For GitHub, almost: everything except the OAuth code exchange
  works from a static page. That exchange still needs the client secret, and
  `github.com/login/*` sends no CORS headers. GitHub's own "SPA support" is
  on its roadmap as Paused. So GitHub needs a ~200-line stateless relay. It
  runs on `forge`, serves the static files too, and keeps no database.
- **Auth.** A new, dedicated GitHub App, `cgwalters-review`, used only
  through user-to-server tokens. The tokens expire after 8 hours, are limited
  to where the app is installed, and are attributed to you. The refresh token
  never reaches JavaScript: it stays in a sealed HttpOnly cookie. On Forgejo,
  an OAuth2 application with scoped grants. The bot's own app (`cgwaltersbot`)
  is never involved.
- **Stack.** The browser app is strict TypeScript with Preact, bundled to
  static files. The relay and the bot-side `review-items` CLI are Rust. A
  forge adapter interface has GitHub and Forgejo implementations.
- **Sign-off.** On GitHub, a reword or sign-off is pure API: new commits
  reusing each original tree, then a compare-and-swap ref update. Forgejo has
  no create-commit API, so on your instance it's done in the browser with
  isomorphic-git, which needs one `app.ini` setting.
- **Prior art.** Nothing does this already. Borrow Backlog.md's file format,
  Gerrit NoteDb's "state changes are commits with trailers", Sveltia CMS's
  dual-forge auth, and ReviewStack's per-commit review UI.

## 1. Source of truth: git and markdown

### What must be stored

1. The queue: what needs you, by priority. Today that's the Workstream board
   (Projects v2: Status, Priority, Workflow, Org, Why, Branch, Gist, and
   draft bodies) plus questions scattered through Why fields, fork-PR
   bot-meta sections and gists. The claude.ai prototype copied 67 of them
   into a hosted store.
2. Your answers to decisions.
3. Review actions on forge PRs: description edits, reworded or signed-off
   commits, `/promote`.

Item 3 already has a native home: the PR is a forge object, and commits are
git. The app edits those in place and adds no store of its own. The question
is items 1 and 2.

### Options

**(a) A git repository of markdown work items.** One file per item, with
front matter for the fields and markdown sections for the prose.
- History, diffs and blame come from git.
- Plain text portable to any forge, or none; readable in any editor or on
  the forge's web UI.
- Concurrency: the contents API update requires the blob sha you last read,
  and rejects stale writes on both
  [GitHub](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents)
  and Forgejo (`sha` is required; a mismatch is `ErrSHADoesNotMatch` in
  [services/repository/files/update.go](https://codeberg.org/forgejo/forgejo/src/branch/forgejo/services/repository/files/update.go)).
  The bot writes with `git pull --rebase` and push. Edits from the two sides
  touch different parts of a file (you: answers; the bot: status and
  results), so rebases stay clean.
- Cost: a sync job if the board is kept, and a migration.

**(b) Issues or PRs as the markdown source, with labels for status.**
- Also markdown, and Forgejo has issue and label APIs.
- But neither forge versions issue bodies in git, and neither has a
  precondition on `PATCH` of an issue or PR body. It is last-writer-wins,
  which is exactly why `bot-pr get-body`/`set-body` has to dig through
  GitHub's edit history to avoid clobbering your edits.
- Issues scatter across repositories, many of them upstream, where the
  bot's queue has no business. A dedicated tracker repo solves that, but it
  becomes (a) without the git history.

**(c) Projects v2 draft bodies (today).**
- Not git; no diffs; GraphQL only; the GraphQL quota is shared by every
  agent.
- GitHub Apps can't access user-owned projects
  ([report](https://dev.to/mfauveau/why-your-github-app-cant-see-your-personal-projects-4d39),
  [discussion](https://github.com/orgs/community/discussions/64849)).
- No Forgejo equivalent. Forgejo's REST API has no project, board or column
  endpoints at all: none in
  [the swagger spec](https://codeberg.org/forgejo/forgejo/src/branch/forgejo/templates/swagger/v1_json.tmpl).
  [forgejo#5330](https://codeberg.org/forgejo/forgejo/issues/5330) is open,
  and the large PR [forgejo#9384](https://codeberg.org/forgejo/forgejo/pulls/9384)
  was closed to be split up.

**Decision: (a).** It's the only option that is git and markdown, portable
to Forgejo, and has a real concurrency primitive on both forges. Issues
remain what they are: upstream conversations the items link to.

### Item format

This follows [Backlog.md](https://github.com/MrLesk/Backlog.md) where it can.
It's the closest existing format: markdown tasks with YAML front matter,
actively maintained, with a CLI and an MCP server.

```markdown
---
title: "composefs varlink: keep the org.composefs prefix?"
status: needs-human        # triage todo in-progress draft needs-human in-review done
priority: P2               # P0..P3
workflow: branch           # branch analysis pr manual
kind: decision             # work decision review action credential
org: composefs
links:
  - https://github.com/composefs/composefs-rs/issues/651
pr: https://github.com/cgwalters-forge/composefs-rs/pull/7   # the forge PR, if any
gist: []
created: 2026-09-24
---

Why this item exists, and the latest result, in a few sentences.

## Questions

### q1: Keep the org.composefs prefix? composefs.org is NXDOMAIN

The name can't change after v1, and the Go server already uses it.

- [ ] Register composefs.org and keep org.composefs (recommended)
- [ ] Switch to io.github.composefs.*
- [ ] Keep the name without owning the domain

#### Answer

```

Rules:
- One file per item. The slug is stable, and the file name is the item's
  identity (`items/composefs-varlink-name-domain.md`). Done items stay in
  place with `status: done`; nothing else needs cleaning up.
- `## Questions` holds one `### qN:` subsection per question, each with
  option checkboxes and an `#### Answer` block. The app answers by checking
  one box and writing under `#### Answer`. Everything else is the bot's.
- Every commit carries trailers, as in Gerrit's
  [NoteDb](https://gerrit-review.googlesource.com/Documentation/note-db.html),
  where review state changes are commits whose footers carry the state:
  `Item: composefs-varlink-name-domain`, `Status: needs-human`,
  `Answered: q1`. `git log --format='%(trailers)' -- items/X.md` is then
  the item's audit log, with no extra store.
- Front matter holds only the current state, which is what `grep`, the app
  and the board mirror read.
- The files hold no private data. The same rule as the board applies: an item
  about a private repository refers to it only by URL. If that's too
  limiting, make the repository private; the app doesn't care.

The format gets a written spec (`docs/items-format.md`) and a fixtures
directory (input file, expected parse, and expected output after an edit).
Both the TypeScript and the Rust implementations test against the fixtures.

### Who writes what, and how

- **You, through the app:** answers, and edits to `status`, `priority` and
  `workflow`. Each is one `PUT /repos/{o}/{r}/contents/items/X.md` carrying
  the blob sha the app read. The commit is authored as you, because a user
  token acts as the user
  ([GitHub](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)).
  On a 409 or 422 (stale sha), the app refetches, reapplies your edit (it
  knows the section it touched) and retries. It shows a conflict only if the
  same answer block changed underneath.
  - The app also rewrites YAML front matter with a format-preserving parser
    ([eemeli/yaml](https://eemeli.org/yaml/)'s Document API), so a status
    change is a one-line diff.
- **You, anywhere else:** editing the file in your editor, in the forge's
  web editor, or in `jj`, is equally valid. That's the point of the design.
- **The bot:** a small `review-items` CLI (Rust, in this repository) replaces
  `bot-board set`. For each change it fetches, edits, commits with trailers,
  and pushes; on a non-fast-forward push it rebases and retries. A text
  conflict never needs a merge: the bot's edits are programmatic ("set
  status to X"), so it resets to the new upstream and reapplies them.
- **Trust.** The bot acts on an answer only if the commit that wrote it is
  authored by the `cgwalters` login. It checks the author via
  `GET /repos/{o}/{r}/commits/{sha}` (`author.login`), not the git author
  string. Only cgwalters and cgwalters-bot get write access to the
  repository.
  - Contents-API commits made with a user token are not signed by GitHub
    ([discussion](https://github.com/orgs/community/discussions/148686)), so
    "Verified" can't be the check.

### How the bot consumes answers

The coordinator loop already polls (`bot-notify`, `bot-pr inbox`,
`bot-watch`). It gains one step:
- `git -C ~/.cache/bot-work/workstream pull --ff-only`, then
  `review-items answered --since <last seen commit>`.
- That lists items with a new answer by cgwalters, from the commit trailers
  and the diff.
- The last-seen commit is a local ref, `refs/bot/seen`. Losing it only means
  re-reading answers that have already been acted on. Acting on an answer
  ends with the bot's own commit (status back to `in-progress`, trailer
  `Acted-on: q1`), so re-reading one is harmless.

This is cheaper than today's polling: one `git fetch` instead of GraphQL
board reads.

### The board, and migration

- **Decision: the markdown repository is authoritative, and the Projects v2
  board becomes a derived, one-way mirror.**
  - `review-items sync-board` updates the board from the files after each
    push. It sets Status, Priority, Workflow, Org, Branch and Gist, puts a
    link to the file in Why, and uses the existing `bot-board` field
    resolution.
  - Board edits are overwritten on the next sync, so triage moves to the
    app, or to editing the file.
  - Once the app covers triage (v1), the mirror is optional. Keep it only if
    you still like the GitHub board view on the phone.
  - Two-way sync is deliberately out of scope: it would make the board a
    second source of truth.
- **Migration** is one-time and scripted, `review-items import`:
  1. Read `bot-board list --json`, plus `bot-board show` for draft bodies.
  2. Write one file per item: Why becomes the body; Branch and Gist become
     links; the `PVTI_` id goes in front matter as `project-item:`, so the
     sync can find each card.
  3. Merge in the prototype's 67 JSON items, matched by their `board_item`
     id or added as new `kind: decision` items. Their options become
     checkboxes.
  4. Commit it all as one reviewable commit.
  5. Then switch `bot-board set` callers to `review-items set`.
  - The `bot-state:` archived items (poll state and the lease) are not work
    items and stay on the board for now. Moving them to git is a separate
    change: a git ref is a natural lease, since pushes are compare-and-swap.
- **Forgejo:** the same format in a repository on your instance
  (`cgwalters/workstream` there). The app can show several item
  repositories in one queue.

## 2. Static-site feasibility

| | GitHub | Forgejo (your instance) |
|---|---|---|
| REST API from a browser | Yes: `api.github.com` sends `access-control-allow-origin: *` and exposes `ETag` and the rate-limit headers (checked with curl, 2026-09-25) | Yes, with `[cors] ENABLED=true` in `app.ini` ([source](https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/setting/cors.go), [middleware](https://codeberg.org/forgejo/forgejo/src/branch/forgejo/routers/api/shared/middleware.go)) |
| PKCE | Yes, S256 only, since [2025-07-14](https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/) | Yes, S256 and plain. Required for public clients (`AuthorizeOAuth` in [routers/web/auth/oauth.go](https://codeberg.org/forgejo/forgejo/src/branch/forgejo/routers/web/auth/oauth.go)) |
| Code exchange without a client secret | **No.** `client_secret` is required even with PKCE ([docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)). GitHub "does not distinguish between public and confidential clients" (changelog above). | **Yes.** The secret is checked only for `ConfidentialClient` apps (`handleAuthorizationCode`, same file) |
| CORS on the token endpoint | **No.** `OPTIONS` and `POST` to `/login/oauth/access_token` and `/login/device/code` return no `Access-Control-*` headers (curl, 2026-09-25). Staff say it is unsupported ([discussion #15752](https://github.com/orgs/community/discussions/15752)). The fix, [roadmap#1153](https://github.com/github/roadmap/issues/1153) "Single page app support for GitHub Apps", was labelled **Paused** on 2026-08-13. | **Yes, when `[cors]` is enabled.** `/login/oauth/access_token` is wrapped by `optionsCorsHandler()` ([routers/web/web.go](https://codeberg.org/forgejo/forgejo/src/branch/forgejo/routers/web/web.go)). Codeberg answers the preflight with `access-control-allow-origin: *`. Send `client_id` in the form body, not in Basic auth: `Authorization` isn't in the allowed headers. |
| Device flow | Needs no secret, but has no CORS either, so it's only useful for a CLI | n/a |
| Commit rewriting | Git Data API from the browser | No API. Needs git over smart HTTP, which needs `[repository] ACCESS_CONTROL_ALLOW_ORIGIN` (off by default) |

**Verdict.**
- **Forgejo: fully static.** It needs a public OAuth2 client with PKCE, plus
  `[cors]` and `[repository] ACCESS_CONTROL_ALLOW_ORIGIN` set to the app's
  origin.
  - [Sveltia CMS](https://sveltiacms.app/en/docs/backends/gitea-forgejo) and
    [Decap CMS](https://decapcms.org/docs/gitea-backend/) already do
    serverless PKCE against Forgejo.
- **GitHub: static plus a stateless relay.** Everything is static except the
  OAuth code exchange and refresh. The relay holds the client secret and a
  cookie-sealing key; it stores nothing.
  - This is the pattern every browser GitHub tool uses:
    [prose/gatekeeper](https://github.com/prose/gatekeeper),
    [sveltia-cms-auth](https://github.com/sveltia/sveltia-cms-auth),
    [utterances-oauth](https://github.com/utterance/utterances-oauth),
    [Giscus](https://github.com/giscus/giscus/blob/main/SELF-HOSTING.md),
    Decap's Netlify provider, and
    [ReviewStack](https://github.com/facebook/sapling/blob/main/eden/contrib/reviewstack.dev/src/NetlifyLoginDialog.tsx),
    which uses Netlify's hosted OAuth proxy, or a pasted PAT elsewhere.
  - GitHub's own
    [best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)
    concede that a public client "cannot secure your client secret" and
    would have to ship it. We won't do that.
- **The zero-server GitHub fallback** is a pasted fine-grained PAT. It's fine
  for v0 read-only, and it stays available as an option. It isn't the target,
  as you said.

**Hosting.** Serve the static bundle and the relay from one origin on
`forge`, under HTTPS, with `tailscale serve` and the MagicDNS certificate
(`https://forge.<tailnet>.ts.net/review/`).
- HTTPS isn't optional. PKCE S256 uses `crypto.subtle`, which only exists
  in [secure contexts](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto),
  and `Secure` cookies need it too.
- Plain `http://forge` would only work with `plain` PKCE on Forgejo and no
  GitHub at all.
- One origin means the refresh cookie is first-party, and the Content
  Security Policy can be tight.
- A phone reaches it through the Tailscale app. Funnel is needed only for
  access without Tailscale.

## 3. Auth

### Options on GitHub

| | Fine-grained PAT | OAuth App token | GitHub App user token (**chosen**) |
|---|---|---|---|
| Reach | Selected repos in one owner | Everything you can reach, by coarse scope (`repo`, `public_repo`) | Where the app is installed and you have access ([docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)). Also "implicit permissions to read public resources" ([docs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)) |
| Permissions | Fine-grained | Coarse scopes | Fine-grained, the app's minus yours |
| Lifetime | Up to a year, manual | Until revoked | 8h, refreshable for 6 months ([docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)) |
| Attribution | You | You | You, with the app's badge on your avatar ([docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)) |
| UX | Paste a secret | Sign in | Sign in |

**Decision: a new dedicated GitHub App, `cgwalters-review`, used only for
user-to-server tokens.**
- It's separate from the bot's identity app (`cgwaltersbot`). Compromising
  the bot's private key then can't act as you, and the review app has no
  private key in use at all: it never mints installation tokens.
- The trade-off: a user token can't write where the app isn't installed. The
  app only acts on your forge PRs (in `cgwalters-forge`), your items
  repository, and your own forks for take-over, so that's the right
  boundary.
- Promotion upstream stays with the bot (`/promote`). Take-over is a push to
  `cgwalters/R` plus a compare link, as in the pivot plan.

### Create the `cgwalters-review` app

Under Settings → Developer settings → GitHub Apps → New GitHub App, owned by
your user account
([docs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)).

- **Name:** `cgwalters-review`. **Homepage:**
  `https://github.com/cgwalters-forge/review`.
- **Callback URLs** (up to 10; `redirect_uri` must match one exactly,
  [docs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url)):
  1. Relay (production):
     `https://forge.<tailnet>.ts.net/review/auth/github/callback`.
  2. Development: `http://127.0.0.1:8787/auth/github/callback`. The GitHub
     App docs don't say whether loopback callbacks are allowed; if the form
     rejects it, use a second tailnet name.
  3. Static-only variant: none today. There's nothing to point at until
     GitHub ships SPA callbacks (roadmap#1153, paused). Then it would be
     `https://forge.<tailnet>.ts.net/review/` marked as an SPA.
- **Expire user authorization tokens:** on (8h access, 6-month refresh).
- **Request user authorization (OAuth) during installation:** off. We always
  pass an explicit `redirect_uri`; with this on, GitHub sends users to the
  first callback URL.
- **Enable Device Flow:** on. It costs nothing and lets a future
  `bot-review` CLI get the same scoped token with no secret. (The device flow
  "does not need" the secret,
  [docs](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).)
- **Setup URL:** none. **Webhooks:** off (uncheck Active). The app polls with
  conditional requests; add webhooks later only if polling proves too slow.
- **Repository permissions:**
  - Contents: read and write. Needed for item files, `git/commits`, and ref
    updates for sign-off.
  - Pull requests: read and write. Needed to edit descriptions, and for
    comments and reviews (`/promote`).
  - Issues: read and write. Needed for comments on issue-linked items.
  - Checks: read, and Commit statuses: read. Used to show CI.
  - Metadata: read (mandatory).
  - Workflows: read and write. Only needed because some forge PRs touch
    `.github/workflows` (gh-agentic-workflows, actions), and rewriting their
    commits pushes workflow files
    ([docs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)).
    Leave it off if you'd rather sign those off with `dco-signoff`.
- **Organization permissions:** Projects read and write, *only* if the board
  mirror is written by the app. It isn't in this design (the bot syncs it),
  so leave it off. There's no user-level Projects permission, and apps can't
  touch user-owned projects anyway.
- **Account permissions:** none.
- **Where can this app be installed: Any account.**
  - A private app owned by a user "can only be installed on the account that
    owns the app"
    ([docs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private)),
    and we need it on the `cgwalters-forge` org too.
  - "Any account" doesn't list the app anywhere. Others installing it gain
    nothing: their tokens only reach their own resources, and the relay is
    tailnet-only.
  - The alternative is for `cgwalters-forge` to own the app. Then it can't be
    installed on your account, which rules out take-over pushes to
    `cgwalters/*`.
- **Install it on:**
  - `cgwalters-forge`, all repositories. That covers the forge forks and the
    items repo.
  - Your account, with selected repositories: the forks you publish
    take-overs from. Or all, if you prefer.
  - bootc-dev and composefs only if you want the app to act upstream as you
    (comment, or edit your upstream PRs). It isn't needed for reading them,
    since public reads are implicit.
- **After creating it:** generate a client secret and store it on `forge` as
  a systemd credential for the relay. Record the client ID in the relay's
  config. Don't generate a private key: nothing needs one.

**Does PKCE let a public client skip the secret? No, not on GitHub, as of
2026-09-25.**
- PKCE is supported but only recommended.
- The token endpoint still lists `client_secret` as required for the web
  flow and for refresh.
- There's no CORS on it (curl above; #15752).
- The SPA work that would remove both limits (roadmap#1153) is paused.

The relay should still send PKCE (S256). GitHub recommends it, and it binds
the code to the browser that started the flow.

### The relay (`review-relay`)

A single Rust binary (axum, reqwest), same origin as the static files. It is
a "token-mediating backend" in the terms of the IETF
[OAuth 2.0 for Browser-Based Applications](https://datatracker.ietf.org/doc/draft-ietf-oauth-browser-based-apps/)
BCP (in the RFC Editor queue): the browser calls the API directly, and the
backend only obtains tokens.

- `GET /auth/github/start`: generates `state` and a PKCE verifier, puts them
  in a short-lived sealed cookie, and redirects to
  `github.com/login/oauth/authorize`.
- `GET /auth/github/callback`: checks `state` and exchanges the code with
  the secret and verifier. It puts the refresh token (and its expiry) in a
  sealed cookie: AES-GCM with a key from a systemd credential, `HttpOnly;
  Secure; SameSite=Strict; Path=/review/auth`. Then it redirects to the app.
- `POST /auth/github/token`: the only way JavaScript gets an access token.
  It unseals the cookie, refreshes (GitHub rotates the refresh token, so the
  cookie is rewritten), and returns `{access_token, expires_at}`.
  - It requires `Origin` to match and a custom header, against CSRF.
- `POST /auth/logout`: clears the cookie. A real revocation calls
  `DELETE /applications/{client_id}/grant`, which also needs the secret, so
  it lives here too.
- The same routes under `/auth/forgejo/*` act as a confidential client for
  Forgejo, so both forges behave the same. The fully static Forgejo mode
  stays supported (see below).

It has no database and no logs of tokens. Restarting it loses nothing, and
rotating the sealing key signs everyone out.

### Forgejo: the equivalent setup

On your Forgejo, under Settings → Applications → Manage OAuth2 applications
([docs](https://forgejo.org/docs/latest/user/oauth2-provider/)):

- **Name:** `cgwalters-review`.
- **Redirect URIs:**
  - `https://forge.<tailnet>.ts.net/review/auth/forgejo/callback` for relay
    mode;
  - `https://forge.<tailnet>.ts.net/review/` for static mode.
  - Loopback `http://127.0.0.1` redirects match on any port for public
    clients, per RFC 8252 (`ContainsRedirectURI` in
    [models/auth/oauth2.go](https://codeberg.org/forgejo/forgejo/src/branch/forgejo/models/auth/oauth2.go)),
    which suits development.
- **Confidential client:**
  - checked for relay mode (the relay holds the secret);
  - unchecked for static mode. PKCE is then mandatory, and the secret is
    never needed.
- **Scopes,** requested at authorize time:
  `write:repository write:issue read:user`.
  - The docs still say "Scopes are not implemented for OAuth2 tokens".
  - But the code turns grant scopes that are valid token scopes into the
    token's scope, falling back to `all` only when none is given
    (`grantAdditionalScopes` in
    [services/auth/method/oauth2.go](https://codeberg.org/forgejo/forgejo/src/branch/forgejo/services/auth/method/oauth2.go),
    covered by `TestOAuth_GrantScopesReadRepository`).
  - Verify on your version during v3.
- **`app.ini`** (the `[cors]` keys are in
  [cors.go](https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/setting/cors.go)):

  ```ini
  [cors]
  ENABLED = true
  ALLOW_DOMAIN = https://forge.<tailnet>.ts.net
  METHODS = GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS
  HEADERS = Content-Type,User-Agent,If-None-Match

  [repository]
  ; git smart HTTP from the browser, only for rewording and sign-off (v3)
  ACCESS_CONTROL_ALLOW_ORIGIN = https://forge.<tailnet>.ts.net

  [oauth2]
  ; defaults: 1h access tokens, 730h refresh tokens, rotation on refresh
  ```
  - The `[cors]` section also covers `/login/oauth/access_token`.
  - `Authorization` is always allowed on `/api`.
  - Forgejo has no GitHub-App-like installations. Since v15, a PAT can be
    limited to specific repositories
    ([v15 release](https://forgejo.org/2026-04-release-v15-0/)), which is
    the zero-OAuth fallback there.

### Token storage and browser hygiene

- **Access tokens live in memory only,** obtained from the relay on load. In
  static Forgejo mode, the refresh token has to be readable by JavaScript.
  Keep it in `sessionStorage`, so closing the tab signs you out. Forgejo's
  1-hour access tokens and refresh-token rotation (`INVALIDATE_REFRESH_TOKENS`)
  limit the damage.
- **No `localStorage` for credentials.** IndexedDB holds only caches and
  unsent drafts.
- **Strict CSP, from the relay or the static server:**
  `default-src 'self'; script-src 'self'; style-src 'self';
  connect-src 'self' https://api.github.com https://<forgejo-host>;
  img-src 'self' data: https://avatars.githubusercontent.com;
  frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, plus
  `require-trusted-types-for 'script'` where supported. There are no
  third-party scripts or fonts. The prototype's Google Fonts go.
- **Untrusted text.** Everything rendered comes from the forge and is
  untrusted: the bot's text, upstream comments, diffs. Render markdown with
  raw HTML disabled (markdown-it `html: false`, which also rejects
  `javascript:` links), and sanitise with DOMPurify as a second layer.
  Diffs and commit messages are text nodes only.
- **Least privilege at runtime.** The UI asks for the relay token only when
  it's about to write. A read-only session (v0) can use a read-only PAT.

## 4. Architecture

### Technology

**Decision: strict TypeScript with Preact, bundled by Vite to static files,
for the browser. Rust for the relay and the bot-side `review-items` CLI.**

- **Why TypeScript here:**
  - The browser side is DOM- and editor-heavy.
  - The pieces it needs are JavaScript libraries with no Rust/WASM equivalent
    of the same maturity: isomorphic-git (Forgejo sign-off), a
    format-preserving YAML editor, markdown-it, DOMPurify, and later
    CodeMirror 6.
  - Strict `tsc` (`strict`, `noUncheckedIndexedAccess`,
    `exactOptionalPropertyTypes`) plus zod-style validation at the API
    boundary gives most of the type safety you'd want, and a phone loads a
    much smaller bundle.
- **Why Rust elsewhere:** the relay handles secrets, and the CLI runs in the
  bot's loop. Both are small, long-lived and security-relevant, where Rust
  earns its keep.
- **Rust/WASM (Leptos or Dioxus) was considered.** It would share the item
  parser with the CLI, but it would mean wrapping isomorphic-git through JS
  interop and a heavier bundle, for a UI that is mostly forms and diffs.
  - The shared fixtures give most of the benefit of a shared parser.
  - If the core logic grows, compile the Rust `items` crate to WASM and call
    it from TypeScript. That's a local change.

### Layout

```
web/            TypeScript app (Vite, Preact)
  src/forge/    Forge interface + github.ts, forgejo.ts
  src/items/    item parse/edit (fixtures in spec/)
  src/ui/       queue, item, PR review views
relay/          review-relay (Rust)
crates/items/   item format library + review-items CLI (Rust)
spec/           items-format fixtures, shared by both test suites
```

### Forge adapter

```ts
interface Forge {
  readonly kind: "github" | "forgejo";
  whoami(): Promise<User>;
  // Items repository
  head(repo: RepoRef, branch: string, etag?: string): Promise<Conditional<Sha>>;
  tree(repo: RepoRef, sha: Sha): Promise<TreeEntry[]>;           // recursive
  blob(repo: RepoRef, sha: Sha): Promise<string>;                // immutable, cached
  putFile(repo: RepoRef, path: string, content: string, baseBlob: Sha,
          message: string): Promise<CommitSha>;                  // precondition
  // Pull requests
  pull(pr: PrRef, etag?: string): Promise<Conditional<Pull>>;
  pullCommits(pr: PrRef): Promise<Commit[]>;
  diff(pr: PrRef, commit?: Sha): Promise<string>;                // unified diff
  checks(pr: PrRef): Promise<CheckSummary>;
  setPullBody(pr: PrRef, body: string, expected: string): Promise<void>;
  comment(pr: PrRef, body: string): Promise<void>;
  // History rewrite with identical trees; fails if the head moved
  rewrite(pr: PrRef, expectedHead: Sha, commits: RewrittenCommit[]): Promise<Sha>;
}
```

A PR or item link is dispatched by its URL's host to the configured forge.
The app's configuration lives in the items repository: `review.yaml` names
the forges, your sign-off identity, and the default sort. So configuration
is git too, and a new browser needs only the items repository's URL.

| Operation | GitHub | Forgejo |
|---|---|---|
| Poll the items repo | `GET /repos/{o}/{r}/commits/{branch}` with `If-None-Match`; a 304 is free ([docs](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)) | `GET /repos/{o}/{r}/branches/{branch}`. The JSON API has no ETags (only raw files do), so compare the commit id |
| Read items | `git/trees/{sha}?recursive=1`, then `git/blobs/{sha}` for changed entries | `git/trees/{sha}?recursive=true`, `git/blobs/{sha}` |
| Answer or edit | `PUT contents/{path}` with `sha` | `PUT contents/{path}` with `sha` (or `POST contents` for several files) |
| PR, commits, diff | `pulls/{n}`, `pulls/{n}/commits`, `Accept: application/vnd.github.diff` | `pulls/{n}`, `pulls/{n}/commits`, `pulls/{n}.diff` |
| Edit PR body | `PATCH pulls/{n}` (no precondition: reread and compare first) | `PATCH pulls/{n}` (same) |
| Reword and sign-off | `POST git/commits` per commit, then GraphQL [`updateRefs`](https://docs.github.com/en/graphql/reference/mutations#updaterefs) with `beforeOid` and `force` (compare-and-swap; REST `PATCH git/refs` has no precondition). Spike it with a user token in v2 | No commit or ref-write API (only reads under `git/`). isomorphic-git in the browser: fetch the branch, rebuild the commits, and force-push. The receive-pack command carries the old value, which acts as the lease (verify isomorphic-git's behaviour in v3) |
| `/promote` | Issue comment | Issue comment |

**Polling.**
- The items repo is polled every 30 seconds while the tab is visible (Page
  Visibility API), and not at all when hidden.
- Linked PRs are polled every 2 minutes with conditional requests, and when
  you open one.
- Blobs are content-addressed, so they're cached in IndexedDB forever. That
  is a pure cache: clearing it loses nothing.
- **GitHub budget:** a user token has 5,000 requests an hour
  ([docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).
  With 304s free, the steady state is close to zero. The app reads
  `X-RateLimit-Remaining` (exposed through CORS) and backs off below 10%.
  GraphQL is used only for `updateRefs`.
- **Forgejo budget:** there's no built-in API rate limiter (Codeberg adds one
  at its proxy), so on your instance only politeness applies.

### UI flows

1. **Queue** (the home screen). It lists items needing you: `needs-human`,
   `draft` items (a PR awaiting review), and unanswered questions. They're
   grouped by priority, then by age. Each card shows the question and its
   options inline, as the prototype did, with one-tap answers. Filters cover
   org, kind and forge. Counts go in the header.
2. **Answer:** check an option, optionally add text, and Send. That's one
   `putFile`, with commit message `answer: <slug> q1` and trailers. The card
   shows "sent" at once and "acted on" when the bot's `Acted-on:` commit
   arrives. Field edits (priority, status, workflow) work the same way.
3. **PR review:** from an item's `pr:` link.
   - It shows the PR description (rendered, editable, with preview), the
     commits as a stack with per-commit diffs (ReviewStack-style navigation),
     the whole diff, and a CI summary.
   - Every commit message is editable in place, with a 72-column ruler and a
     trailer-aware "Sign off" toggle. The toggle appends
     `Signed-off-by: <name> <email>` from `review.yaml`, deduplicated.
4. **Rewrite and sign off** ("Save to forge"):
   - The app shows a before/after of each message, and checks that each new
     commit reuses the original tree.
   - It creates the new commits (author unchanged, committer you), then does
     a compare-and-swap ref update against the head you reviewed. If the bot
     pushed in the meantime, the update fails and the app reloads, with your
     edits kept as drafts.
   - Per the workstream rules, once you've pushed, the bot treats the branch
     as yours and only adds `fixup!` commits.
   - GitHub doesn't sign commits with a custom committer. Projects that
     require signed commits still go through the CLI.
5. **Promote:** after the rewrite, comment `/promote` (optionally with
   `/draft`) on the forge PR. `bot-pr promote` already acts on that, and
   D6's sign-off gate checks your exact `Signed-off-by`. The app offers
   "Sign off and promote" as one button that runs step 4 and then step 5.
6. **Description edits:** fetch the body, edit, then refetch just before
   `PATCH`. If the body changed since you started, show a three-way view.
   This is the same safety as `bot-pr set-body`, from the other side.

Small code edits are deferred to v2.x: a blob, then a tree, then a commit on
GitHub; contents `POST` with `signoff` on Forgejo. Anything bigger goes to
the CLI.

### Offline and local-first

- The app shell is cached by a service worker, which needs the HTTPS origin.
- Items and diffs you've viewed are readable offline from the blob cache.
- Answers and message edits written offline are kept as drafts in IndexedDB,
  marked unsent. They're submitted when you're back online, with the same
  blob-sha preconditions, so a stale draft becomes a visible conflict rather
  than an overwrite.
- There's deliberately no sync engine: git and the forge are the sync layer.
- For real offline work, the answer is a clone. The files are plain markdown,
  and the planned `bot-review` CLI (jj-based, from the pivot plan) does
  rewording locally.

## 5. Prior art

| Project | Model | Verdict |
|---|---|---|
| [Backlog.md](https://github.com/MrLesk/Backlog.md) | Markdown tasks with YAML front matter in `backlog/tasks/`, with a CLI, TUI, MCP and a local web server. Active (v1.53.0, 2026-09-24). No forge sync. | **Borrow the file format.** Stay compatible where cheap, so its CLI and MCP could read our items. Not a base: its UI is a local server, and it knows nothing of PRs. |
| [Gerrit NoteDb](https://gerrit-review.googlesource.com/Documentation/note-db.html) | Review state as commits on `refs/changes/XX/N/meta`, with state in footers (`Patch-set:`, `Label:`, `Status:`). Linear, because the server is the single writer. | **Borrow:** state changes are commits with trailers on a normal branch. |
| [git-appraise](https://github.com/google/git-appraise) | Reviews as JSON lines in git notes (`refs/notes/devtools/*`), merged with `cat_sort_uniq`. Web UI is a Go server. Last commit 2023-08. | **Borrow** the append-only idea. Notes are invisible on both forges and not markdown. |
| [git-bug](https://github.com/git-bug/git-bug) | Operation-based CRDT, JSON blobs under `refs/bugs/`. GraphQL web UI server. GitHub/GitLab/Jira bridges; the Gitea/Forgejo bridge is WIP ([#1628](https://github.com/git-bug/git-bug/pull/1628)). Very active (v0.11.0, 2026-09-22). | **Ignore as a base:** hidden refs, JSON, needs a server, models issues rather than PR review. Revisit if multi-writer offline merging ever matters. |
| [Radicle](https://radicle.dev/guides/protocol) (heartwood) | Collaborative objects (issues, patches with revisions and reviews) in git under `refs/cobs/`, on its own peer-to-peer network. | **Borrow** the patch, revision and verdict vocabulary. It means leaving GitHub and Forgejo. |
| [Sapling ReviewStack](https://github.com/facebook/sapling/tree/main/eden/contrib/reviewstack) | A static React UI over GitHub GraphQL, with per-commit stack review. MIT, maintenance only, GitHub only, read-only. Auth via Netlify's OAuth proxy or a PAT. | **Borrow** the UX and diff rendering, and it proves a serious static review UI works. Adding writes and Forgejo would be a rewrite. |
| [Sveltia CMS](https://sveltiacms.app/en/docs/backends) | A static app committing markdown through GitHub, GitLab and Forgejo APIs. Serverless PKCE on Forgejo; a worker for GitHub OAuth. | **Borrow** the auth approach, and read its Forgejo client when writing ours. |
| Pages CMS, Utterances, Giscus | A server with Postgres; issues or discussions as storage. | **Ignore:** a lookaside DB, or the forge as the DB. |

**Decision: build new, small.** Nothing combines a static app, GitHub plus
Forgejo, PR rewording and sign-off, and git plus markdown as the only store.
The borrowed pieces keep it small.

## 6. Plan

- **v0: static read-only queue.**
  - Items format spec and fixtures.
  - A migration of the board and the prototype into the items repository.
  - The web app reading items over the GitHub API with conditional polling,
    and rendering the queue.
  - Auth with a read-only fine-grained PAT (no relay yet).
  - Deployed as static files on `forge` via `tailscale serve`; GitHub Pages
    works too.
- **v1: answers and field edits.**
  - The relay and the `cgwalters-review` app.
  - Writes through `putFile` with preconditions.
  - `review-items answered` in the coordinator loop, and
    `review-items set`/`sync-board` replacing `bot-board set`.
  - The board becomes a mirror.
- **v2: PR review and sign-off.** PR view, diff, commit stack, message
  editor, rewrite through the Git Data API plus `updateRefs`, "Sign off and
  promote", and description edits.
- **v3: Forgejo.** The Forgejo adapter, OAuth (static or relay mode),
  isomorphic-git rewriting, and a second items repository on your instance.

**First PRs, in order:**
1. `spec: Define the work item format`. Adds `docs/items-format.md` and
   `spec/fixtures/` (input, parsed JSON, and after-edit output), including
   the prototype's decision shape.
2. `items: Add item parser and review-items CLI`. A Rust crate with
   data-driven tests over the fixtures: `import`, `list`, `set`.
3. `items: Import the Workstream board and the prototype queue`. Run once,
   into the new items repository, after you pick its name. It's reviewed as
   a single commit there.
4. `web: Add read-only queue over a GitHub items repository`. Vite, Preact,
   strict TypeScript, the `Forge` interface with a read-only GitHub adapter,
   conditional polling, and CSP. Includes a CI workflow (typecheck, unit
   tests, `cargo test`).
5. `relay: Add GitHub App token relay`. axum, sealed refresh cookie, PKCE,
   and a systemd unit plus `tailscale serve` notes. It needs the app's client
   ID and secret.

## Open questions for cgwalters

1. **The items repository.** Is `cgwalters-forge/workstream` right, and
   public (same privacy rule as the board today) or private? And is it OK
   for the Projects board to become a read-only mirror, with triage moving
   to the app or the files?
2. **The `cgwalters-review` app.** It's owned by your account and set to
   "Any account", so it can be installed on `cgwalters-forge` as well as on
   your account. Is that acceptable, versus an org-owned app that can't
   reach `cgwalters/*`? Also:
   - Include Workflows RW?
   - Install on bootc-dev and composefs?
3. **What I need about your existing app `cgwaltersbot`.** Confirm it stays
   the bot's identity and is never used for review.
   - Its owner (your user or an org) and its install setting (only this
     account, or any account).
   - Whether "Expire user authorization tokens" is on.

   None of this blocks the review app. It matters for the pivot plan's D1/D2,
   and it makes sure the two apps don't overlap in permissions or
   installations. For `cgwalters-review` I need its client ID, and the
   client secret delivered to `forge` as a systemd credential (not through
   the bot).
4. **The `forge` host.** What's its MagicDNS name? Is HTTPS through
   `tailscale serve` fine? Phone access through the Tailscale app, or also
   Funnel?
5. **Sign-off identity.** The exact `Signed-off-by` name and email, per
   forge. It goes in `review.yaml`.
6. **Your Forgejo instance.** Which version (v15 LTS or v16)? Are the
   `[cors]` and `[repository] ACCESS_CONTROL_ALLOW_ORIGIN` changes OK? Static
   public-client mode, or the same relay for both forges (my default)?
7. **Stack.** TypeScript for the browser, Rust for the relay and CLI. Or
   would you rather pay the cost of Rust/WASM (Leptos) for the UI too?
