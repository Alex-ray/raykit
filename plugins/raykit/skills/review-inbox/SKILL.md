---
name: review-inbox
description: >
  Monitor and review the PRs you're tagged on. Discovers open, non-draft PRs where
  the current user is a requested reviewer (across all repos), runs the principal-engineer
  review workflow (depth scaled to size, adversarially verified), posts a terse, human-voice
  PENDING review per PR (author-only — never submitted), and briefs you on what each PR is
  for alongside an approve / request-changes / comment recommendation.
  Trigger: "/raykit:review-inbox", "review my PRs",
  "check my review queue", or on a schedule.
---

# Review inbox

Generalizes a principal-engineer review pipeline to your whole review queue.
**Everything posted is a PENDING review — visible only to you, never sent to PR authors.**
You submit (or edit/delete) each one yourself.

Resolve the current GitHub user once at the start and reuse it:

```
ME=$(gh api user -q .login)
```

`gh` sometimes fails in a sandbox with a TLS cert error (`OSStatus -26276`). If a `gh`
call fails that way, rerun it with the sandbox disabled.

## 1. Discover the queue

```
gh search prs --review-requested=@me --state=open --archived=false --json number,title,isDraft,repository
```

- `--archived=false` excludes PRs from archived repos — they're read-only, so you can't act on
  them (this is a common source of never-clearing queue noise).
- Drop any `isDraft: true`.
- Skip any repo on your ignore-list (see Notes).
- For each remaining PR, get size + head:
  `gh pr view <n> --repo <owner/repo> --json additions,changedFiles,headRefName,mergeStateStatus`

## 2. Skip what's already handled

Being in the search result means you are **currently** a requested reviewer. GitHub removes
you the moment you submit a review and only re-adds you on an explicit re-request — so a PR
in this list is either new or a genuine re-ping. The one thing to guard against is
re-posting on top of a pending review you already left:

```
gh api repos/<owner/repo>/pulls/<n>/reviews -q "[.[] | select(.user.login==\"$ME\") | .state]"
```

- If the result contains `"PENDING"` → **skip** (already reviewed; waiting on you).
- Otherwise (no review, or only submitted reviews) → **review it** (new, or re-requested after
  a prior submit).

## 3. Review (workflow, depth scaled to size)

Pass all to-review PRs to the bundled workflow in one call. The script ships with this
plugin — reference it by absolute path:

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/pr-principal-review.js", args: [
  { number, repo: '<owner/repo>', additions, files: changedFiles, title }, ...
]})
```

It fans out reviewers by dimension (1 for small PRs, ~3 for medium, ~6 + verify for large),
adversarially verifies every high/critical, and returns per PR:

```
{ pr, repo, brief, recommendation, summary, body,
  comments: [{path,line,body,severity}],       // NEW findings only
  replies:  [{thread_id,body,resolve,status,gist,path}],   // your last round, re-judged
  dropped:  [{comment,thread_id,reason}] }     // repeats folded into existing threads
```

Comments and replies come back already terse and in a human voice — post them verbatim.

- `brief` is the orientation pass — `{ purpose, mechanism, ticket, affects, gaps }` — written for
  someone who has never seen the work. Use it for step 6; **never** put it in the posted review
  body (see step 4).
- `body` is the submit-ready review summary, opening with the recommendation. Post it as-is.
- `replies` only appears on a re-review. Each entry is one of your own earlier threads, re-judged
  against the current code: `fixed` (ack + resolve), `partial` (they changed it and it's still
  broken), `not_fixed`, `stale`. The workflow verifies rather than trusting the author's
  resolution, and skips threads you already answered in a prior round.
- `dropped` is findings this round that repeat an existing thread. They're already accounted for by
  that thread's reply — don't post them, but do mention the count in step 6.

## 4. Post one PENDING review per PR

Order matters: the review must exist before replies can be staged into it.

### 4a. Create the pending review with the new findings

POST with **no `event` field** — that's what keeps it pending:

```
# payload.json: {"body": "<result.body>", "comments":[{"path","line","side":"RIGHT","body"}, ...]}
gh api --method POST repos/<owner/repo>/pulls/<n>/reviews --input payload.json -q '.id, .node_id'
```

Keep the `node_id` (`PRR_…`) — 4b needs it.

- Use the workflow's `body` verbatim. It already opens with the recommendation, which matters
  because **GitHub cannot preselect the approve / request-changes radio** — `event` only exists at
  submit time, and submitting is exactly what this skill never does. The body is the only prefill
  available, so it carries the verdict as text.
- The body is the **overview of the review being submitted**: the verdict, the pattern the findings
  add up to, and anything with no line to sit on (work missing from the diff, a description that
  contradicts the code, coverage that dropped, a cross-cutting concern). Anything that could be
  anchored to a line is an inline comment and is already posted as one — it must not be restated
  here. If you find yourself pasting findings into the body, that's the wrong place for them.
- `comments` is `result.comments` only. Never re-post anything in `dropped`.
- Keep `brief` out of the review entirely. It's your orientation, and the author does not need you
  explaining their own PR back to them — a pending review becomes visible to them the moment you
  submit it.
- Comments must anchor to lines in the diff (the workflow only emits in-diff lines). If a
  POST 422s on a comment, move that comment into the review `body` instead and retry.
- If a PR's diff is empty (stale-base / conflicting), post the findings as the review `body`
  only, no inline comments.
- If the POST returns 422 `lock prevents review`, the PR's conversation is locked — skip it
  and note it in the summary; don't retry.
- Only one pending review per PR is allowed; the step-2 guard prevents duplicates.

### 4b. Stage the replies on your earlier threads (re-review only)

For each entry in `result.replies`, stage a reply **into the pending review** so it stays
author-invisible until you submit. This only works over GraphQL — REST cannot do it
(`POST /pulls/{n}/comments` with `in_reply_to` publishes immediately, and the reviews endpoint
rejects `inReplyTo` outright: `DraftPullRequestReviewComment` has no such field):

```
gh api graphql -f query='
mutation($review:ID!,$thread:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{
    pullRequestReviewId:$review, pullRequestReviewThreadId:$thread, body:$body
  }){ comment{ state } } }' \
  -f review="<PRR_… from 4a>" -f thread="<reply.thread_id>" -f body="<reply.body>"
```

Expect `state: PENDING`. If it comes back anything else, stop and say so — something published.

### 4c. Resolve the threads that are genuinely fixed

For each reply with `resolve: true`:

```
gh api graphql -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' -f t="<thread_id>"
```

**This one is immediate** — resolution can't be staged, so it's visible to the author before you
submit. It's the single sanctioned exception to author-invisibility, and only ever on threads the
workflow verified as fixed in the current code. Never resolve a `partial`/`not_fixed` thread, and
never unresolve one the author closed — a `partial` reply sits on the resolved thread and is
surfaced to you in step 6 instead.

## 5. Open the reviewed PRs for the human to sign off

This is the critical step — the AI only drafts; a human reviews the pending comments in the
browser and submits. For every PR that got a pending review, open its **Files changed** view
(where inline comments render) in the default browser:

```
open "https://github.com/<owner/repo>/pull/<n>/files"     # macOS
```

On non-macOS, print the URLs instead. Skip PRs that were skipped or blocked (e.g. locked).

## 6. Brief the human

Send one push notification summarizing the run:

```
PushNotification: "Reviewed N PR(s): #x request-changes, #y comment, #z approve. Pending — submit when ready."
```

Then print the real output — a rundown per PR, in this order:

1. **Heading** — repo, number, title, size (`additions+`, N files), and the PR URL.
2. **What it's for** — `brief.purpose`, then `brief.mechanism`. Plain prose, your own words, no
   field labels. Add the `ticket` as a link if there is one. This comes first because the
   recommendation is meaningless until you know what the change is trying to do.
3. **What it touches** — `brief.affects`, so the weight of the findings is obvious.
4. **Recommendation** — always print it explicitly per PR: approve / comment / request changes,
   plus the severity counts. You have to click that radio yourself at submit time, so this line is
   the only place you'll see the call before you do — never leave it implicit or roll it up across
   PRs.
5. **Since last round** (re-review only) — what got fixed, as a count plus a one-liner. Then, one
   by one, every `partial` and `not_fixed`: those are the ones where the author believes they're
   done and they aren't, so they need the most words. Say which of them are sitting on threads the
   author already resolved.
6. **The findings** — the substance of each *new* inline comment, grouped or clustered if there are
   many. Don't just report counts; the point is that they can judge the calls without opening the
   diff. Note the `dropped` count so it's clear repeats were folded into existing threads rather
   than lost.
7. **Worth asking the author** — `brief.gaps`, if non-empty. Flag it as a question, not a finding;
   it isn't in the posted review.
8. **The review comment you'll be submitting** — print `result.body` verbatim, quoted, so it's
   obvious it's the staged text and not your narration. This is the one thing that goes out under
   your name the instant you hit submit, so you get to read it before that, not after. Don't
   paraphrase it and don't silently rewrite it; if it reads wrong, say so and fix it on the review
   (step 4a's payload) rather than only in the printout.

Keep it skimmable and factual. If a brief came back empty (`brief: null`), say the context pass
failed for that PR rather than inventing a purpose from the title. Do **not** submit anything.
If nothing was eligible, send nothing (or a quiet "review queue clear").

## Recommendation rubric (the workflow computes this; surface it)

- **request changes** — any critical/high, or a substantive medium (correctness, security,
  tenancy, data-integrity, idempotency, fail-loud/fail-open, provenance, migrations).
- **comment** — only minor issues, cleanups, or doc accuracy.
- **approve** — clean.

## Notes

- Scope is cross-repo by default. Archived repos are already excluded via `--archived=false`.
  To also ignore specific *active* repos, keep a short ignore-list of `owner/name`s and drop them
  in step 1.
- Requires `gh` authenticated as the reviewing user.
- Never `--no-verify`, never submit reviews, never post visible comments to PR authors. Resolving a
  verified-fixed thread (4c) is the one immediate action, because GitHub has no pending equivalent.
- What can and can't be staged, established by probing the API — don't re-litigate it:
  a new inline comment can (REST), a reply on an existing thread can (GraphQL only), resolving a
  thread cannot, and the approve/request-changes choice cannot.
- Deleting a pending review deletes its staged replies with it, so a re-run is clean: drop the
  pending review and rebuild rather than trying to patch it.
