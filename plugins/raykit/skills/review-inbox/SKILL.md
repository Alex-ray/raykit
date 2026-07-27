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
`{ pr, repo, brief, recommendation, summary, comments:[{path,line,body,severity}], bodyOnly }`.
Comments come back already terse and in a human voice — post them verbatim.

`brief` is the orientation pass — `{ purpose, mechanism, ticket, affects, gaps }` — written for
someone who has never seen the work. It runs concurrently with the review, so it's free. Use it
for step 6; **never** put it in the posted review body (see step 4).

## 4. Post one PENDING review per PR

For each result, build the payload and POST with **no `event` field** (that keeps it pending):

```
# payload.json: {"body": "<summary>", "comments":[{"path","line","side":"RIGHT","body"}, ...]}
gh api --method POST repos/<owner/repo>/pulls/<n>/reviews --input payload.json
```

- Set the review `body` to the workflow's `summary` plus the recommendation, e.g.
  `Recommend: request changes. 2 high, 3 medium — inline.`
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
4. **Recommendation** — approve / comment / request changes, plus the severity counts.
5. **The findings** — the substance of each inline comment, grouped or clustered if there are many.
   Don't just report counts; the point is that they can judge the calls without opening the diff.
6. **Worth asking the author** — `brief.gaps`, if non-empty. Flag it as a question, not a finding;
   it isn't in the posted review.

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
- Never `--no-verify`, never submit reviews, never post to PR authors.
