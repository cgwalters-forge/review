# review: design

Status: proposal, revised 2026-09-25 after an independent fact-check.
Tracks
[cgwalters-bot/cgwalters-bot#8](https://github.com/cgwalters-bot/cgwalters-bot/issues/8)
and builds on the review-workflow part of the pivot plan
([gist](https://gist.github.com/cgwalters-bot/17b14e3407e4cb30bda7cb03e58e2481)).
Each **Decision** is a recommendation for cgwalters to accept or overrule.
The questions for him are at the end.

## Revision: the board is the backend (2026-09-25)

cgwalters decided against a new items repository: "the *app* can be public
but yes we may have some private repos so we don't want to leak that. I
think the *backend* could again be a project/issues/gist". So, for now,
this replaces §1 (the items repository, its format, `review-items`, the
board mirror and the migration). Auth, hosting, CSP, rendering and deploys
(§2, §3) stand as written; the GitHub app comes first, Forgejo later.

- **No data in the app.** The code is public. Everything about items is
  fetched at runtime with your token, so nothing private reaches the
  source, the build, logs or a public store. Test fixtures are synthetic.
- **The queue** is the Workstream board: items with Status "Needs human",
  grouped by Priority, with Why, Org, Branch and Gist, plus the item's
  issue or PR (or draft body) and any gist for long context.
- **Reads are REST, not GraphQL.** `GET /users/{u}/projectsV2/{n}/items`
  takes `fields=<ids>` and `q=status:"Needs human"`, sends
  `access-control-allow-origin: *` and ETags (checked 2026-09-25). Polls
  are conditional requests, so an unchanged board costs no rate budget.

### Answers, and why the bot can trust them

The bot's existing rule is that only the `cgwalters` login carries intent.
Answers therefore are things only that login can create:

- **Issue or PR items:** a comment by you on it. Its first line is
  `/answer`, `/answer B` or `/answer B Q#3` (see question ids below), and
  the rest is your text.
  - The app never copies option text from the bot into the comment, so a
    confused bot can't put words under your name.
  - It refuses free text with a line that is a bot command (`/promote`,
    `/draft`, `/ready`, `/answer`, after trimming whitespace): `bot-pr`
    acts on `/promote` on *any* line of your comments, so "ok" followed
    by a `/promote` line in an answer would promote a fork PR. Backticks
    or other wording get around it on purpose.
  - On a public repository outside `cgwalters-forge`, `cgwalters-bot` and
    `cgwalters`, the app asks before posting. (With the App's user token,
    comments work only where the App is installed; see the open problem
    below. `answerTarget` is the one place that picks the channel.)
- **Draft items** have no comments, and their edits are unattributed:
  `DraftIssue` and `ProjectV2Item` expose only a creator and `updatedAt`,
  and there is no edit history (GraphQL introspection, 2026-09-25). So the
  app saves a **receipt gist** under your account (unlisted: `public:
  false`), holding the same block plus an `Item: PVTI_...` trailer, then
  writes a marked section into the draft body pointing at it:

  ```
  <!-- review-answer BEGIN receipt=https://gist.github.com/<id> -->
  /answer B Q#3
  your text
  <!-- review-answer END -->
  ```

  The body section is only a pointer and a display; only the receipt is
  evidence. The markers must be whole lines, and a body with more than
  one section, or a malformed one, is refused rather than guessed at.
  **The board is public**, so the section, and through its link the
  receipt, are readable by anyone: answers on drafts are public today,
  whatever "unlisted" suggests. The app says so next to the send button.

**Question ids.** The bot names each question it asks with an id at the
start of a line, `Q#3: backport to 1.2? Options: A) ... B) ...`, in Why
(where it then starts the field) or the draft body, and uses a new number
whenever it asks something new on that item. Only `Q#n:` at the start of
a line counts, so an id in a URL, backticks or prose never does. The app
copies the id into the answer's command line. Different ids between Why
and the draft body, or within one, make the question ambiguous, and the
app refuses to answer. The bot:
- rejects an answer whose id isn't the current question's, an answer
  without an id to a question with one, and an answer with an id to a
  question without one;
- always also requires the answer to be newer than the item's move to
  Needs human.

Together these reject a replayed comment or receipt, an answer to
options that changed while the view was open, and an answer from before
the question was asked.

**What the bot checks** (a separate homegit change, in `bot-watch`, with
one verifier shared with `bot-pr inbox`; not in this repository):
- a comment's author is `cgwalters`, and it was not edited by anyone else
  (people with write access can edit others' comments, so check
  `userContentEdits` editors, as `bot-pr` does for PR bodies);
- a receipt, fetched by the gist id (never trusting the user named in
  the URL), has `owner.login` `cgwalters`; `fork_of` null; exactly one
  revision (`history.length == 1`), by `cgwalters`; exactly one file,
  `answer.md`, not truncated; an `Item:` trailer naming this item;
- the answer's question id matches the current question's, both ways
  (see question ids above), and the answer is newer than the item's move
  to Needs human;
- then it acts, and moves the item on as today. Unverified answers are
  reported to you, not acted on. The app shows a draft as answered only
  once its receipt passes the same checks (except timing), and otherwise
  as "body claims an answer (unverified)".

### Auth changes

The relay and the `cgwalters-review` App stay as in §3; v0 ships the
client side (it asks `POST auth/github/token`, and only on a loopback
origin falls back to a pasted token, for development), and the relay
itself is the next PR. The App
additionally needs **account permission Gists: read and write** for
receipts; Contents write is not needed until PR review (v2).

**Open problem:** the board is owned by the `cgwalters-bot` user, and
GitHub Apps have no account-level Projects permission (§1(c)). Reading a
public board should work, but writing a draft body with the App's user
token is expected to fail with "Resource not accessible by integration".
In development mode a classic token with `project` scope works if you can
edit the board. The fix is the org project the pivot plan already calls
for, with the App granted org Projects: read and write. App user tokens
also reach only repositories where the App is installed, so upstream
`/answer` comments would fail in relay mode; one alternative is private
answers everywhere (a receipt plus a board "Answer" field). Both wait on
your decision.

**Plan, revised:** v0 is the GitHub queue, the item view and answers, as
above, in development mode. Next come the relay, the bot's answer check
in homegit, and the App (created by you, with its secret installed by you
on `forge`). PR review (§6 v2) and Forgejo follow.

## Summary

- **Source of truth.**
  - Work items become markdown files with a small, restricted front matter
    in an ordinary git repository: `items/<slug>.md`, provisionally in
    `cgwalters-forge/workstream`.
  - The app writes your answers as commits, through the contents API.
  - The bot reads them with `git pull`. It trusts an answer only if **you
    pushed** the commit that introduced it, which it checks against the
    forge's push log, not the commit's author fields.
  - PRs, their descriptions and their commits stay where they already are,
    on the forge and in git.
  - The Projects board becomes a one-way mirror, and later optional.
- **Static site?**
  - Forgejo: yes. Its OAuth2 provider accepts public clients with PKCE, and
    its token endpoint honours the instance's `[cors]` settings.
  - GitHub: everything except the OAuth code exchange. That still requires
    the client secret, and `github.com/login/*` has no CORS; GitHub's
    single-page-app work is Paused. So GitHub needs a small stateless relay.
  - Both are served tailnet-only from `forge` with `tailscale serve`.
- **Auth.**
  - GitHub: a dedicated GitHub App, `cgwalters-review`, used only through
    user-to-server tokens. They expire after 8 hours, are limited to where
    the app is installed, and are attributed to you. The relay is a
    token-mediating backend (RFC 10017 §6.2) that keeps the refresh token in
    a sealed HttpOnly cookie.
  - Forgejo: an OAuth2 application with scoped grants.
  - The bot's own app, `cgwaltersbot`, is never involved.
- **Shape.**
  - A shared item-format library, plus two thin client-side apps, one for
    GitHub and one for Forgejo. Both are strict TypeScript.
  - The relay and the bot's `review-items` CLI are Rust.
  - The served code is deployed only from commits you approved, and the bot
    can't touch what's served.
- **Sign-off.**
  - GitHub: pure API. New commits reuse each original tree, then a
    compare-and-swap ref update.
  - Forgejo: no commit-creation API. The browser uses isomorphic-git with a
    pre-push head check, or the relay does the rewrite server-side.
- **Prior art.** Nothing does this already. We borrow ideas from Gerrit
  NoteDb, Backlog.md, Sveltia CMS and ReviewStack.

## 1. Source of truth: git and markdown

*Superseded for now by the revision at the top: the board and issues are
the backend, not an items repository.*

### What must be stored

1. **The queue: what needs you, by priority.** Today that's spread across:
   - the Workstream board (Projects v2, owned by the `cgwalters-bot` user):
     Status, Priority, Workflow, Org, Why, Branch, Gist, and draft bodies;
   - questions in Why fields, fork-PR bot-meta sections and gists;
   - the claude.ai prototype, which copied 67 of them into a hosted store.
2. **Your answers** to decisions, and your triage approvals (triage → todo).
3. **Review actions on forge PRs:** description edits, reworded or
   signed-off commits, `/promote`.

Item 3 already has a native home: the PR is a forge object, and its commits
are git. The app edits them in place and adds no store of its own. The open
question is where items 1 and 2 live.

### Options

**(a) A git repository of markdown work items.** One file per item.
- History, diffs and blame come from git.
- It's plain text: portable to any forge, or none.
- Both forges' contents API refuse an update whose blob `sha` is stale:
  - [GitHub](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents)
    documents 409/422;
  - on Forgejo a mismatch is `ErrSHADoesNotMatch`, returned as 409 (`routers/api/v1/repo/file.go`).
- The costs: a board sync if the board is kept, a migration, and a trust
  check (below).

**(b) Issues or PRs as the markdown source, with labels for status.**
- Neither forge versions issue bodies in git.
- Neither has a precondition on `PATCH` of a body: last writer wins. That's
  why `bot-pr set-body` has to reconstruct your edits from GitHub's edit
  history.
- A dedicated tracker repo of issues is (a) without the git history.

**(c) Projects v2 draft bodies (today).**
- Not git, and GraphQL only, on a quota every agent shares.
- GitHub Apps can't access user-owned projects: there's no account-level
  Projects permission, and reports say "Resource not accessible by
  integration" ([dev.to](https://dev.to/mfauveau/why-your-github-app-cant-see-your-personal-projects-4d39),
  [discussion](https://github.com/orgs/community/discussions/64849)).
- Forgejo's REST API has no project endpoints at all (none in
  [the swagger spec](https://codeberg.org/forgejo/forgejo/src/branch/forgejo/templates/swagger/v1_json.tmpl)).
  [forgejo#5330](https://codeberg.org/forgejo/forgejo/issues/5330) is
  open, and [forgejo#9384](https://codeberg.org/forgejo/forgejo/pulls/9384)
  was closed unmerged to be split up.

**Decision: (a).** It's the only option that is git plus markdown, portable to
Forgejo, and has a concurrency primitive on both forges.

### Item format

The format is loosely modelled on
[Backlog.md](https://github.com/MrLesk/Backlog.md) (markdown tasks with front
matter) but is **not compatible with its tooling**. Backlog.md expects
`task-N - Title.md` names, an `id`, and its own status values.

```markdown
---
format: 1
title: "composefs varlink: keep the org.composefs prefix?"
status: needs-human
priority: P2
rank: 35
workflow: branch
kind: decision
org: composefs
links: [https://github.com/composefs/composefs-rs/issues/651]
pr: https://github.com/cgwalters-forge/composefs-rs/pull/7
created: 2026-09-24
---

Why this item exists and the latest result, in a few sentences.

## Questions

### q1: Keep the org.composefs prefix? composefs.org is NXDOMAIN

The name can't change after v1, and the Go server already uses it.

- A) Register composefs.org and keep org.composefs (recommended)
- B) Switch to io.github.composefs.*
- C) Keep the name without owning the domain

<!-- answer q1 BEGIN -->
<!-- answer q1 END -->
```

**Rules:**
- **Front matter is a restricted YAML subset:**
  - exactly one `key: value` per line;
  - values are plain or double-quoted scalars, or a flow list `[a, b]`;
  - no comments, anchors or multi-line values.

  Both sides can then edit one field by rewriting one line, and a full YAML
  parser still reads the file.
  - This avoids needing format-preserving YAML libraries. The TypeScript
    `yaml` library reflows aligned trailing comments: a test with yaml 2.9.1
    changed two lines to set one field. On the Rust side the only candidate,
    `yaml-edit`, is young.
- **`format: 1`** versions the schema. Unknown keys and unknown sections are
  preserved byte-for-byte, and fixtures check it.
- **Values:**
  - `status`: triage, todo, in-progress, draft, needs-human, in-review or
    done.
  - `priority`: P0 to P3.
  - `rank`: orders items within a priority (Projects keeps manual order;
    files need it spelled out).
  - `workflow`: branch, analysis, pr or manual.
  - `kind`: work, decision, review, action or credential.
- **Answer blocks are delimited by BEGIN/END markers, not headings.**
  - The app writes only between the markers of one question. It records the
    chosen letter as a first line `choice: A`, followed by free markdown.
  - The bot never writes between the markers, so the two writers never
    touch the same lines.
  - Headings, lists or anything else inside an answer are just content.
  - A literal `<!-- answer ... END -->` line typed in an answer is escaped by
    the app.
- **One file per item.** The slug is its identity, and done items stay in
  place.
- **Every commit carries trailers**, as Gerrit's NoteDb records review state
  in commit footers (defined in
  [ChangeNoteFooters.java](https://gerrit.googlesource.com/gerrit/+/refs/heads/master/java/com/google/gerrit/server/notedb/ChangeNoteFooters.java)).
  - Examples: `Item: composefs-varlink-name-domain`, `Status: needs-human`,
    `Answered: q1`.
  - `git log --format='%(trailers)' -- items/X.md` is then the item's
    history.
  - Trailers are claims for humans and tools to read, not proof of anything
    (see Trust).
- **No private data.** Same rule as the board: an item about a private
  repository refers to it only by URL. The repository could be private
  instead; the app doesn't care.

The format gets a spec (`docs/items-format.md`) and fixtures, shared by the
TypeScript and Rust test suites:
- parse fixtures;
- round-trip fixtures (unchanged bytes out);
- edit fixtures, including "set one field → exactly one line of diff" and
  "answer q1 → only lines between q1's markers change".

### Who writes what

- **You, through the app:** answers, triage approvals, and edits to
  `status`, `priority`, `rank` and `workflow`.
  - Each is one `PUT /repos/{o}/{r}/contents/items/X.md` carrying the blob
    `sha` the app read. The precondition is per file, not per branch head.
  - On a conflict (409 or 422), or a 5xx, the app refetches, reapplies your
    edit and retries with backoff.
    - The 5xx case matters on Forgejo: its contents API commits in a
      temporary clone and pushes back, so a race with another push surfaces
      as a 500 (`services/repository/files/temp_repo.go`,
      `routers/api/v1/repo/file.go`).
    - The app shows a conflict only if the same answer block changed
      underneath.
  - GitHub asks that contents writes be serialised, so the app sends one at
    a time.
- **You, anywhere else:** your editor, the forge's web editor, `jj`. All are
  equally valid, and the trust check below covers them.
- **The bot:** the `review-items` CLI (Rust, in this repository) replaces
  `bot-board set`.
  - It fetches, applies its edit, commits with trailers, and pushes.
  - Its edits are programmatic ("set status to X"), so on a rejected push it
    resets to the new upstream and reapplies them. It never merges or
    rebases text. Neighbouring front-matter lines touched by both sides would
    conflict in a rebase, so it doesn't rebase.

### Trust: the bot acts only on what you pushed

**The rule:** the bot acts on an answer, or on a triage → todo approval, only
if the commit that introduced those lines was **pushed by the `cgwalters`
login**.

**Author fields are not evidence.**
- GitHub links a commit to a user "by matching the email address", and your
  email is public.
- Both forges' contents and commit APIs accept arbitrary `author` and
  `committer` fields. On Forgejo see `services/repository/files/file.go`.
- So the bot's token, if prompt-injected, could create a commit that looks
  like it's yours.
- GitHub also doesn't sign contents-API commits made with a user token.
  Only requests "authenticated as the GitHub App or bot" with no custom
  author or committer are signed ("Signature verification for bots" in
  [about commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)).
  So "Verified" doesn't help either.
- Trailers are claims too.

**How the bot checks** (`review-items answered`):
1. For each answer block or status line that changed since the last check,
   `git blame` the lines. This is per line, not per file: your commit on top
   of a bot commit doesn't vouch for the bot's lines. That gives the
   introducing commit C.
2. Find the push that introduced C:
   - **GitHub:** [`GET /repos/{o}/{r}/activity`](https://docs.github.com/en/rest/repos/repos#list-repository-activities)
     lists ref updates with `before`, `after` and `actor` (checked live on
     this repository).
   - **Forgejo:** `GET /repos/{o}/{r}/activities/feeds`, where a
     `commit_repo` entry has `act_user`, `ref_name`, and the pushed range in
     its content (`CompareURL`, and `Commits`, which is truncated to
     `FEED_MAX_COMMIT_NUM`, so use the range).
   - C was introduced by the push whose range contains it: reachable from
     `after`, and not from `before`.
3. Act only if that push's actor is `cgwalters`. Otherwise report "unverified
   answer" to him and ignore it.

This works for contents-API commits, which record a push by the token's
user, and equally for your own `git push`.
- Restrict the repository's write access to `cgwalters` and `cgwalters-bot`.
- The bot runs the check on every poll, well within any activity-log
  retention. How long that log is retained is undocumented; see the open
  questions.

### How the bot consumes answers

The coordinator loop gains one step next to `bot-notify`, `bot-pr inbox` and
`bot-watch`:
- `git pull --ff-only` of the items clone;
- then `review-items answered --since refs/bot/seen`, which lists items with
  verified new answers.
- Acting on an answer ends with the bot's own commit (e.g.
  `Acted-on: q1`), so losing the local `refs/bot/seen` ref only means
  re-reading answers it has already acted on.

This is one `git fetch` plus one activity call per poll, where today it's
GraphQL board reads.

### The board, and what the mirror loses

**Decision: the files are authoritative. The Projects board becomes a
derived, one-way mirror** (`review-items sync-board`, using `bot-board`'s
field resolution). What that changes:

- **Board edits are overwritten.** State this in the board's description. The
  sync reports any field that differs from the files before overwriting it,
  so a stray edit is visible rather than silently lost. Triage moves to the
  app or the files.
- **Ordering.** Manual in-priority ordering on the board has no equivalent
  in files, so `rank:` carries it and the sync orders cards by it.
- **Live cards.** Issue and PR cards on the board show live state; a file's
  `status` doesn't update itself. `bot-watch` already notices merges and
  closes; it now rewrites the files (e.g. `status: done`), and the mirror
  follows.
- **Answer channels today:** Why-field edits, draft-body edits, and your
  comments on fork PRs. Why and body edits become answer blocks. PR comments
  and `/promote` stay as they are, via `bot-pr inbox`.
- **Issue assignments.** `bot-notify` today adds issues you assign to the bot
  to the board. It will create an item file instead, with `status: todo`,
  since it's your action, verified by the notification's actor as now.
- **Ownership.** The board belongs to the `cgwalters-bot` user, and the
  pivot plan moves the bot to an org project. The mirror follows wherever the
  board goes. Nothing in this design needs the board, so after v1 keep it
  only if you like the board view.

**Migration** is one-time and scripted (`review-items import`), and the result
is reviewed as a single commit:
- one file per board item: Why becomes the body; Branch and Gist become
  links; the `PVTI_` id goes in `project-item:`;
- the prototype's 67 items, merged by their `board_item` id, with options
  lettered.

Then the callers of `bot-board set` switch to `review-items`. The
`bot-state:` archived items (poll state, the lease) aren't work items and
stay put for now.

## 2. Static-site feasibility

| | GitHub | Forgejo (your instance) |
|---|---|---|
| REST API from a browser | Yes. `api.github.com` sends `access-control-allow-origin: *` and exposes `ETag` and the rate-limit headers (curl, 2026-09-25) | Yes, with `[cors] ENABLED=true` ([cors.go](https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/setting/cors.go); `/api` always allows `Authorization`, per `routers/api/shared/middleware.go`) |
| PKCE | S256 only, since [2025-07-14](https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/) | S256 and plain, **required** for public clients (`AuthorizeOAuth` in [routers/web/auth/oauth.go](https://codeberg.org/forgejo/forgejo/src/branch/forgejo/routers/web/auth/oauth.go)) |
| Code exchange without the secret | **No.** `client_secret` is required even with PKCE ([docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)); GitHub "does not distinguish between public and confidential clients" | **Yes** for apps not marked confidential (the secret is checked only for `ConfidentialClient`) |
| CORS on the token endpoint | **No.** Preflight and POST to `/login/oauth/access_token` and `/login/device/code` return no `Access-Control-*` (curl). In [#15752](https://github.com/orgs/community/discussions/15752), staff said CORS on the token endpoint is not supported yet. [roadmap#1153](https://github.com/github/roadmap/issues/1153), "Single page app support for GitHub Apps [Preview]", was labelled **Paused** on 2026-08-13, and its plan caps SPA refresh tokens at possibly ~24h | **Yes**, when `[cors]` is enabled. `optionsCorsHandler()` wraps `/login/oauth/access_token` ([web.go](https://codeberg.org/forgejo/forgejo/src/branch/forgejo/routers/web/web.go)). Its allowed headers are only `[cors] HEADERS`, so send `client_id` in the body, not Basic auth |
| Rewriting commits | Git Data API | No API: every `git/*` route is read-only except notes. Needs git smart HTTP with `[repository] ACCESS_CONTROL_ALLOW_ORIGIN` |

**Verdict:**
- **Forgejo is fully static.** It needs a public OAuth2 client with PKCE,
  plus the `[cors]` and git-HTTP CORS settings.
  [Sveltia CMS](https://sveltiacms.app/en/docs/backends/gitea-forgejo) and
  [Decap CMS](https://decapcms.org/docs/gitea-backend/) do exactly this.
- **GitHub is static plus a stateless relay** for the code exchange and
  refresh. It's the pattern used by
  [prose/gatekeeper](https://github.com/prose/gatekeeper),
  [sveltia-cms-auth](https://github.com/sveltia/sveltia-cms-auth),
  [utterances-oauth](https://github.com/utterance/utterances-oauth),
  [Giscus](https://github.com/giscus/giscus/blob/main/SELF-HOSTING.md) and
  [ReviewStack](https://github.com/facebook/sapling/blob/main/eden/contrib/reviewstack.dev/src/NetlifyLoginDialog.tsx)
  (Netlify's proxy, or a PAT).
  - GitHub's
    [best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)
    concede a public client would have to ship its secret.
- **Fallback with no server:** a pasted fine-grained PAT, which is fine for
  the v0 read-only queue.

**Hosting: tailnet only.**
- One origin on `forge` via `tailscale serve`, with the MagicDNS HTTPS
  certificate: `https://forge.<tailnet>.ts.net/review/`. All your devices,
  the phone included, are on the tailnet.
- Public exposure (Funnel, GitHub Pages) is out of scope. If it were ever
  wanted: Pages can't set response headers, so the CSP would go in a
  `<meta>` tag, where `frame-ancestors` doesn't work.
- **Why HTTPS:**
  - service workers, `Secure` cookies and `crypto.randomUUID` need a secure
    context;
  - GitHub callbacks other than loopback should be HTTPS.
  - S256 PKCE by itself could work over plain HTTP with a pure-JS SHA-256
    and `crypto.getRandomValues`, which isn't restricted to secure contexts
    ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto)).
- **Note:** Tailscale certificates come from Let's Encrypt, so
  `forge.<tailnet>.ts.net` appears in public Certificate Transparency logs.
  That reveals the name, not access.

## 3. Auth

### GitHub: which token

| | Fine-grained PAT | OAuth App token | GitHub App user token (**chosen**) |
|---|---|---|---|
| Reach | Selected repos of one owner | All you can reach, by coarse scope | The intersection of what you can reach and where the app is installed ([docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)), plus implicit read of public resources ([docs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)) |
| Permissions | Fine-grained | Coarse | The intersection of your permissions and the app's |
| Lifetime | Up to a year | Until revoked | 8h, refreshable for 6 months, refresh token rotated on use ([docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)) |
| Attribution | You | You | You, with the app's badge ([docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)) |

**Decision: a dedicated GitHub App, `cgwalters-review`, for user tokens only.**
- It's separate from the bot's `cgwaltersbot`, so a compromise of the bot's
  key can't act as you. It never uses a private key.
- Its rate budget is your user's 5,000 requests an hour, **shared with your
  other tokens** (`gh`, PATs, other apps acting as you)
  ([docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).
  Conditional requests that return 304 are free when they're authorised
  ([docs](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)).

### Create the `cgwalters-review` app

Settings → Developer settings → GitHub Apps → New GitHub App, owned by your
user account
([docs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)).

- **Callback URLs** (up to 10;
  [docs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url)):
  - `https://forge.<tailnet>.ts.net/review/auth/github/callback`
  - For development, `http://127.0.0.1:8787/auth/github/callback`. Loopback
    is documented only for OAuth apps, so if the form rejects it, use a
    second tailnet name.
  - A purely static variant has no callback today. That waits on
    roadmap#1153.
- **Wildcard matching for callback URLs:** leave it **off**. It's new
  (August 2026) and off by default for new apps, and GitHub advises enabling
  it only when necessary
  ([changelog](https://github.blog/changelog/2026-08-14-multiple-redirect-uris-and-token-refresh-for-oauth-apps/)).
- **Expire user authorization tokens:** on.
- **Request user authorization (OAuth) during installation:** off. The relay
  always passes `redirect_uri`, and with this on GitHub sends users to the
  first callback.
- **Enable Device Flow:** **off**. GitHub's best practices say "Don't enable
  device flow without reason": it needs no redirect URI, so it can be used
  for phishing. Revisit if a CLI ever needs it.
- **Webhooks:** off. **Setup URL:** none.
- **Repository permissions:**
  - Contents: read and write;
  - Pull requests: read and write;
  - Issues: read and write;
  - Checks: read;
  - Commit statuses: read;
  - Metadata: read.
  - **Workflows: off by default.** Rewriting commits that touch
    `.github/workflows` needs it, so sign those off with `dco-signoff`
    instead, unless you decide otherwise.
- **Organization and account permissions:** none. The bot syncs the board
  mirror, not this app.
- **Where can this app be installed:**
  - **Any account** is needed: a private app owned by a user "can only be
    installed on the account that owns the app"
    ([docs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private)),
    and it must go on `cgwalters-forge` too.
  - A public app gets an install page at `github.com/apps/cgwalters-review`.
    It isn't listed in the Marketplace.
  - Others installing it gain nothing: their tokens reach only their own
    resources, and the relay is tailnet-only.
- **Install with selected repositories:**
  - On your account: only the forks you publish take-overs from.
  - On `cgwalters-forge`: the items repository plus the forks under review.
    New forks appear daily, so choosing "all repositories" there is the
    pragmatic alternative. The bot can already write there; the extra power
    a stolen token adds is acting as you (e.g. `/promote`). See the open
    questions.
  - bootc-dev and composefs only if you want the app to act upstream as
    you. Reading them is implicit.
- **Afterwards:** generate a client secret and install it on `forge` as a
  systemd credential of the relay's user (see Deployment). Don't generate a
  private key.

**Does PKCE let a public client skip the secret? No, not on GitHub as of
2026-09-25.**
- The web-flow exchange and refresh both list `client_secret` as required.
  The only exception is refreshing a device-flow token.
- There's no CORS on the token endpoint, and the SPA feature is Paused.
- The relay still sends S256 PKCE, as GitHub recommends.

### The relay: a token-mediating backend

A single Rust binary (axum, reqwest) on the same origin as the static files.
[RFC 10017](https://www.rfc-editor.org/rfc/rfc10017) (BCP 212, OAuth 2.0 for
Browser-Based Applications) calls this pattern a **token-mediating backend**
(§6.2). It is a confidential client that hands the application access tokens.

**§6.2's trade-off:** it "is less secure than a BFF". Injected script can't
get at the refresh token or the session cookie, but it can steal the current
access token, or "request a fresh token from the token-mediating backend"
(§5.1.4). So the deciding defence is that no attacker-controlled script runs
on the origin. That's why deployment and CSP below are not optional.

Endpoints:
- `GET /auth/github/start`:
  - generates `state` and a PKCE verifier, and seals them into a cookie:
    `HttpOnly; Secure; SameSite=Lax; Path=/review/auth/github/callback;
    Max-Age=600`;
  - it must be Lax: the callback is a cross-site top-level navigation from
    github.com, which would drop a Strict cookie;
  - then redirects to `github.com/login/oauth/authorize`.
- `GET /auth/github/callback`: checks `state` and exchanges the code with the
  secret and verifier. It sets the session cookie, sealed with AES-GCM under
  a key from a systemd credential: `HttpOnly; Secure; SameSite=Strict;
  Path=/review/auth`. The cookie holds:
  - the refresh token and its expiry;
  - **the current access token and its expiry.**
- `POST /auth/github/token`:
  - requires a matching `Origin` and a custom header (the CSRF defence
    §6.2.3.3 asks for on this endpoint);
  - returns the sealed access token if it has more than 10 minutes left, and
    **only refreshes near expiry**;
  - GitHub rotates refresh tokens on every use, so concurrent refreshes would
    log you out. The relay single-flights refreshes per session (an
    in-process lock keyed by a hash of the cookie; nothing persistent), and
    the browser serialises its own calls across tabs with the Web Locks API.
- `POST /auth/logout`:
  - clears the cookie;
  - revokes with `DELETE /applications/{client_id}/grant`, which takes a
    *valid* access token in the body, so it refreshes first if needed.

The relay has no database and doesn't log tokens. Rotating the sealing key
signs everyone out. The same code handles `/auth/forgejo/*` for relay-mode
Forgejo.

### Forgejo: the equivalent setup

`ConfidentialClient` is a per-application setting, so relay mode and static
mode need **two OAuth2 applications**, created under Settings → Applications
([docs](https://forgejo.org/docs/latest/user/oauth2-provider/)):

| App | Confidential | Redirect URI |
|---|---|---|
| `cgwalters-review` (relay mode) | yes | `https://forge.<tailnet>.ts.net/review/auth/forgejo/callback` |
| `cgwalters-review-static` | no (PKCE mandatory) | `https://forge.<tailnet>.ts.net/review/forgejo/` |

- For development, public clients match `http://127.0.0.1` redirects on any
  port. It must be the IP literal, not `localhost` (`ContainsRedirectURI` in
  [models/auth/oauth2.go](https://codeberg.org/forgejo/forgejo/src/branch/forgejo/models/auth/oauth2.go)).
- **Scopes:** request `write:repository write:issue read:user`.
  - The docs say "Scopes are not implemented for OAuth2 tokens", but the code
    applies grant scopes that are valid token scopes to the token
    (`grantAdditionalScopes` in `services/auth/method/oauth2.go`, tested in
    `tests/integration/oauth_test.go`). Verify on your version.
  - **Changing the scopes later requires revoking the existing grant
    first.** Otherwise authorize fails with "a grant exists with different
    scope" (`routers/web/auth/oauth.go`).
- **Refresh:**
  - `INVALIDATE_REFRESH_TOKENS` defaults to **true** in code
    (`modules/setting/oauth2.go`), although `app.example.ini` shows `false`.
  - Reusing a refresh token fails with "token was already used", so two tabs
    refreshing at once log you out.
  - Same remedy as on GitHub: cache the access token (1h by default) and
    refresh near expiry under a Web Locks single-flight.
- **`app.ini`:**

  ```ini
  [cors]
  ENABLED = true
  ALLOW_DOMAIN = https://forge.<tailnet>.ts.net
  ; HEADERS keeps its default (Content-Type,User-Agent). If-None-Match is
  ; useless: Forgejo's JSON API sends no ETags (only raw and media files do).

  [repository]
  ; git smart HTTP from the browser, only for rewording and sign-off
  ACCESS_CONTROL_ALLOW_ORIGIN = https://forge.<tailnet>.ts.net
  ```

  - **Caveat:** with `[service] REQUIRE_SIGNIN_VIEW = true`, the sign-in
    check runs before the git-HTTP CORS handler (`routers/web/githttp.go`).
    The unauthenticated preflight then gets a 401 and browser git fails. In
    that case, use the relay's server-side rewrite (§4).
- **Tokens:** Forgejo has no installation-scoped app tokens. Since v15, a PAT
  can be limited to repositories
  ([v15 release](https://forgejo.org/2026-04-release-v15-0/)), which is the
  no-OAuth fallback.

### Browser hygiene

- **Where tokens live:**
  - Access tokens are kept in memory only.
  - In static Forgejo mode the refresh token has to be readable by
    JavaScript. It goes in `sessionStorage`, so closing the tab signs you
    out.
  - Nothing credential-like goes in `localStorage`. IndexedDB holds only
    caches and unsent drafts.
- **CSP**, sent as a header by the relay or static server:
  `default-src 'self'; script-src 'self'; style-src 'self';
  connect-src 'self' https://api.github.com https://<forgejo>;
  img-src 'self' data: https://avatars.githubusercontent.com;
  frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, plus
  `require-trusted-types-for 'script'`. There are no third-party scripts or
  fonts.
- **Rendering untrusted text:** everything shown is untrusted.
  - Markdown goes through markdown-it with `html: false`, which also refuses
    `javascript:` and `data:text/html` links, then DOMPurify.
  - Diffs and commit messages are rendered as text nodes.

### Deployment and supply chain

The relay will mint a token acting as you for any script running on its
origin (§6.2 above). So the served code is the security boundary:
- **Deploy only commits you approved.** `forge` deploys only tags signed by
  your key, checked with `git verify-tag` against your key, as
  `bin/git-verify-tag-with-key` does. It builds from the tag, with lockfile
  installs only.
- **The bot never deploys.** On `forge`, the served files, the relay binary
  and its systemd credentials (client secrets, the sealing key) belong to a
  dedicated `review` user. They're unreadable and unwritable by the bot's
  user, and the bot has no sudo there.
- The bot may open PRs on this repository like any other, and you review
  them. Dependencies are pinned and few (Preact, markdown-it, DOMPurify,
  isomorphic-git).

## 4. Architecture

### Two thin apps, one shared library

**Decision: no general forge abstraction.** Separate GitHub and Forgejo apps
are fine, and simpler. The layout:

```
packages/items/   item format: parse, edit, round-trip (TypeScript)
packages/ui/      queue + item components (Preact), fed plain item data
apps/github/      GitHub client: REST + one GraphQL mutation, relay auth
apps/forgejo/     Forgejo client: REST + isomorphic-git, static or relay auth
relay/            review-relay (Rust)
crates/items/     item format + review-items CLI (Rust)
spec/             format spec fixtures, run by both test suites
```

- Each app owns its API calls and flows, with no common interface to
  satisfy.
- What's shared is data: the item model, plus the queue components that
  render it.
- The Forgejo app starts as a copy-and-adapt of the GitHub app's PR views.
  Shared code is extracted only once it's clearly identical.

**Technology.**
- **Browser: strict TypeScript + Preact, bundled by Vite.**
- **Relay and CLI: Rust,** where secrets and the bot's loop live.
- **Why not Rust/WASM for the browser (Leptos, Dioxus)?** Rust has mature
  markdown (comrak, pulldown-cmark) and sanitising (ammonia). The gap is
  elsewhere:
  - isomorphic-git for Forgejo: gitoxide builds for wasm32 only as plumbing
    crates, with no browser transport;
  - an editor (CodeMirror 6);
  - bundle size on a phone.
- The restricted front matter removes the need for a format-preserving YAML
  library on either side.

### API use

| Operation | GitHub app | Forgejo app |
|---|---|---|
| Poll items repo | `GET commits/{branch}` with `If-None-Match` (304 is free) | `GET branches/{branch}`, comparing the commit id (no ETags) |
| Read items | `git/trees/{sha}?recursive=1`, `git/blobs/{sha}`; blobs cached forever by sha | same paths |
| Answer or edit | `PUT contents/{path}` with `sha`; retry on 409, 422 and 5xx | same, and 5xx expected on a race |
| PR, commits, diff | `pulls/{n}`, `pulls/{n}/commits`, `Accept: application/vnd.github.diff` | `pulls/{n}`, `pulls/{n}/commits`, `pulls/{n}.diff` |
| Edit PR body | `PATCH pulls/{n}` after rereading and comparing (no precondition) | same |
| Reword and sign-off | `POST git/commits` per commit, then GraphQL [`updateRefs`](https://docs.github.com/en/graphql/reference/mutations#updaterefs) with `beforeOid` (compare-and-swap; REST `PATCH git/refs` takes only `sha` and `force`) | isomorphic-git: fetch the branch, rebuild the commits, push with `force`, and use `onPrePush` to cancel unless `remoteRef.oid === expectedHead`. `force` alone isn't a lease: the old value sent is whatever the server advertised at push time |
| `/promote` | issue comment | issue comment |

**Polling:**
- The items repo is polled every 30 seconds while the tab is visible. Linked
  PRs are polled every 2 minutes, and whenever you open one.
- The app reads `X-RateLimit-Remaining` and backs off below 10% of the
  shared budget.
- Forgejo has no built-in API rate limiter.

### UI flows

1. **Queue:** items needing you (`needs-human`, `draft`, unanswered
   questions, `triage`), grouped by priority and ordered by `rank`. Options
   answer in one tap, as in the prototype.
2. **Answer, or approve triage:** one `PUT` writing only inside the answer
   markers, or the `status` line. The card shows "sent" at once, and "acted
   on" once the bot's `Acted-on:` commit arrives.
3. **PR review:**
   - the rendered, editable description;
   - the commit stack, with per-commit diffs (ReviewStack-style navigation);
   - the CI summary;
   - each commit message editable in place, with a "Sign off" toggle that
     appends your `Signed-off-by` from `review.yaml` (in the items repo).
4. **Rewrite and sign off:**
   - the app shows each message before and after, and checks that every tree
     is reused;
   - it writes new commits: author unchanged, committer you;
   - then a compare-and-swap ref update against the head you reviewed. If the
     bot pushed meanwhile, the update fails and your edits stay as drafts.
   - GitHub doesn't sign commits with a custom committer. Projects that
     require signed commits go through the CLI.
5. **Sign off and promote:** step 4, then a `/promote` comment. `bot-pr
   promote` and its D6 sign-off gate do the rest.

Also from issue #8, placed in the plan:
- **Take-over** (v2.1): rewrite with your identity and the project's trailer
  policy, drop the bot-meta section, and push to `cgwalters/R`, which needs
  the app installed on that fork. Then open the compare link for you to
  create the PR. The item is marked `workflow: manual`.
- **Per-project trailer policy** (v2.1): `policy.yaml` in the items
  repository, mapping a repo to "bot posts" or "take-over" and a trailer
  style. It's in git, and reviewed like everything else.
- **Small code edits** (v2.2):
  - GitHub: blob → tree → commit;
  - Forgejo: the contents API (which supports `signoff`).
  - Anything larger goes to the jj-based `bot-review` CLI from the pivot
    plan.

### Offline

- A service worker caches the app shell. Blobs you've viewed stay readable
  from IndexedDB, which is a pure cache.
- Answers written offline are kept as unsent drafts. They're submitted with
  the same preconditions once you're back online.
- There's no sync engine: git and the forge are the sync layer. For real
  offline work, clone the items repo.

## 5. Prior art

| Project | What it is | Verdict |
|---|---|---|
| [Gerrit NoteDb](https://gerrit-review.googlesource.com/Documentation/note-db.html) | Review state as commits on `refs/changes/XX/N/meta`, with the state in footers (`Patch-set:`, `Label:`, `Status:`; [ChangeNoteFooters.java](https://gerrit.googlesource.com/gerrit/+/refs/heads/master/java/com/google/gerrit/server/notedb/ChangeNoteFooters.java)) | **Borrow:** state changes are commits with trailers, on a normal branch |
| [Backlog.md](https://github.com/MrLesk/Backlog.md) | Markdown tasks with front matter, a CLI/TUI, and a local web server. Active (v1.53.0, 2026-09-24) | **Loosely modelled on it; not compatible with its tooling.** Its `<!-- AC:BEGIN -->` markers inspired our answer markers |
| [git-appraise](https://github.com/google/git-appraise) | Reviews as JSON lines in git notes, merged with `cat_sort_uniq`. Dormant since 2023-08, not archived | **Borrow** the append-only idea. Notes are invisible on both forges |
| [git-bug](https://github.com/git-bug/git-bug) | An operation-based CRDT in JSON blobs under `refs/bugs/`, with a GraphQL server UI. The Forgejo bridge is a draft ([#1628](https://github.com/git-bug/git-bug/pull/1628)). Active (v0.11.0) | **Not a base:** hidden refs, JSON, needs a server |
| [Radicle](https://radicle.dev/guides/protocol) | Collaborative objects (issues, patches, reviews) under `refs/cobs/`, on its own peer-to-peer network | **Borrow** the patch/revision/verdict vocabulary |
| [Sapling ReviewStack](https://github.com/facebook/sapling/tree/main/eden/contrib/reviewstack) | A static React UI over GitHub GraphQL with per-commit stack review. It writes comments, reviews and labels, but can't rewrite commits. MIT, GitHub only | **Borrow** its UX. Proof that a static review UI works |
| [Sveltia CMS](https://sveltiacms.app/en/docs/backends) | A static app committing markdown via the GitHub and Forgejo APIs, with serverless PKCE on Forgejo | **Borrow** its auth approach |
| Pages CMS | A Next.js app with **Postgres** | **Ignore:** it has a lookaside DB |
| Utterances, Giscus | Issues or discussions as the store. Utterances uses a Cloudflare worker; Giscus a GitHub App, with optional caching | **Ignore:** the forge becomes the database |

**Decision: build new and small,** borrowing the pieces above.

## 6. Plan

- **v0: static read-only queue (GitHub).**
  - Format spec and fixtures.
  - `review-items import` of the board and the prototype.
  - The GitHub app reading the items repo with a read-only PAT.
  - Deployed on `forge` from a tag you signed.
- **v1: answers, triage, and Forgejo read-only.**
  - The relay and `cgwalters-review`; writes with preconditions.
  - `review-items answered` with the push-actor check;
    `review-items set`/`sync-board`.
  - The board becomes a mirror.
  - A read-only Forgejo app over an items repo on your instance, which
    proves the shared library early.
- **Spikes before v2:**
  1. `updateRefs` with `beforeOid` using a user token.
  2. Cross-fork tree reuse: a commit in `cgwalters/R` built from trees of
     `cgwalters-forge/R`, which relies on the shared fork network.
  3. The GitHub activity API's retention and pagination on a busy
     repository.
- **v2: PR review and sign-off on GitHub.** v2.1 adds take-over and trailer
  policy; v2.2 adds small code edits.
- **v3: Forgejo writes.** OAuth (static or relay), and rewrites with
  isomorphic-git. **Fallback:** the relay does the rewrite server-side, with
  a real git clone on `forge` using your token. The token is held only for
  that request and never stored. This is needed anyway under
  `REQUIRE_SIGNIN_VIEW`.

**First PRs:**
1. `spec: Define the work item format`: `docs/items-format.md` and
   `spec/fixtures/` (parse, round-trip, one-line-edit, answer-block edits).
2. `items: Add item parser and review-items CLI`: the Rust crate with
   data-driven fixture tests; `import`, `list`, `set`.
3. `items: Import the Workstream board and the prototype queue`: run once
   into the items repository, reviewed as one commit.
4. `web: Add read-only GitHub queue`: `packages/items` (TypeScript, same
   fixtures), `packages/ui`, `apps/github`, CSP, and CI (typecheck, tests,
   `cargo test`).
5. `relay: Add GitHub App token relay`: sealed cookies, PKCE,
   single-flight refresh, the systemd unit for the `review` user, and a
   signed-tag deploy script.
6. `items: Verify answers by push actor`: `review-items answered`, with
   fixtures for forged-author and rebased-on-top cases.

## Later (not in scope)

**Codespace-on-devspace mode:** trying a change live, browsing all of the
code, and talking to an agent about it, on a devspace. Recorded here only as
a direction. This design stays a lightweight client-side app.

## Open questions for cgwalters

1. **The items repository.**
   - Is `cgwalters-forge/workstream` right, and public or private?
   - Is it OK for the board to become a read-only mirror, with edits there
     overwritten?
2. **Installs of `cgwalters-review`.**
   - Is "Any account" acceptable? It gives the app a public install page,
     but it's unlisted in the Marketplace.
   - On `cgwalters-forge`: selected repositories (you add each new fork), or
     all repositories?
   - Workflows stays off unless you want it.
   - Install on bootc-dev and composefs?
3. **Your existing app, `cgwaltersbot`.**
   - Confirm it stays the bot's identity only, never used for review.
   - Who owns it (your user or an org), and what's its install setting?
   - Are expiring user tokens on?

   This doesn't block the review app, but it matters for D1/D2 of the pivot
   plan. For `cgwalters-review` I need its client ID, and the secret
   installed by you on `forge` as the `review` user's credential, never
   through the bot.
4. **`forge`.**
   - Its MagicDNS name.
   - Is the name appearing in Certificate Transparency logs acceptable?
   - Can a dedicated `review` user own the deployment, with the bot's user
     unable to read or write it?
   - Which key signs deploy tags?
5. **Sign-off identity:** the exact `Signed-off-by` name and email.
6. **Your Forgejo.**
   - Its version, and whether `REQUIRE_SIGNIN_VIEW` is on.
   - Are the `[cors]` and git-HTTP CORS settings acceptable?
   - Static mode, or relay mode (the default)?
7. **Trust check.** Is "pushed by `cgwalters`, per the forge's push log" the
   rule you want for answers and triage approvals, including edits you make
   outside the app?
