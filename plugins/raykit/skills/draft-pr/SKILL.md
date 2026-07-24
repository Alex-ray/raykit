---
name: draft-pr
description: >
  Open a pull request the way Alex likes it: always as a draft, with a terse description
  that says only what the code can't (the why, the constraints, the non-obvious decisions —
  never a restatement of the diff). Optionally runs a principal-engineer review round on the
  new PR and either auto-fixes findings until clean or hands you the insights to act on.
  Trigger: "/raykit:draft-pr", "open a PR", "create a PR", "raise a draft PR", "ship this as a draft".
---

# Draft PR

Opens the PR as a **draft** — always. Never `--ready`, never undraft, never merge; you
promote it yourself after review.

`gh` sometimes fails in a sandbox with a TLS cert error (`OSStatus -26276`). If a `gh` call
fails that way, rerun it with the sandbox disabled.

## 1. Prepare the branch

- Never commit on the default branch. If `git branch --show-current` is `main`/`master`, cut a
  feature branch first (name it from the ticket or a short slug).
- Make sure the change is committed and the branch is pushed with tracking:
  `git push -u origin <branch>`.
- Commit through hooks — **never `--no-verify`**. If a hook blocks, fix the blocker and re-commit.
- Only stage what belongs to this change; don't sweep unrelated working-tree files in.

## 2. Write the description — only what the code can't say

The diff already shows *what changed*. The description carries **only what can't be inferred
from the code**:

- **Why** — the motivation, the problem, the constraint that forced this shape.
- **Decisions & trade-offs** — the alternative you rejected and why; a non-obvious approach.
- **Risk / blast radius** — migrations, flags, anything a reviewer should watch.
- **How to verify** — only when it isn't obvious from the tests.
- The ticket link, if there is one.

Leave everything else out. **No** file-by-file walkthrough, **no** per-commit table, **no**
"this PR adds X to Y" narration, **no** restating the diff. If a line is inferable from the
code, delete it. Terse, human voice — a colleague's note, not a report. Drop any heading with
nothing real to say; a one-line "why" is a complete description. Omit a test plan on docs-only
or trivial changes.

## 3. Create it as a draft

```
gh pr create --draft --base <base> --head <branch> --title "<title>" --body "<the terse body>"
```

- Title follows the repo's convention (check `CONTRIBUTING.md`); default to Conventional Commits.
- **Always `--draft`.** Print the PR URL.

## 4. Offer the principal review round (optional)

Ask whether to run a principal-engineer review pass on the new PR. If declined, stop after the
summary.

If yes, review the PR with the bundled workflow (shared with `review-inbox`):

```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/pr-principal-review.js",
           args: [{ number, repo: '<owner/repo>', additions, files: changedFiles, title }] })
```

It fans out reviewers by dimension (scaled to size), adversarially verifies every high/critical,
and returns `{ recommendation, summary, comments:[{path,line,body}] }`. Comments come back
already terse and in a human voice.

## 5. Resolve findings — your choice

Show the findings terse (severity · file:line · one line each) with the recommendation, then ask
which:

- **Auto-fix** — apply every finding, commit through hooks, push, and **re-run the review round**.
  Loop until a round returns no findings, or 3 rounds (whichever first); report each round's
  deltas. Fix the actual defect — never suppress (no ignore-comments, no `--no-verify`, no
  deleting the assertion).
- **Hand off** — change nothing. Post the findings as a **pending** review on the draft PR
  (POST with no `event` field → author-only, never submitted) so you act on them in the browser,
  and print the summary.

Only escalate to the fix loop what's worth fixing (the recommendation rubric: request-changes =
correctness/security/tenancy/data-integrity/fail-open/migrations; comment = minor/cleanup/docs).

## 6. Summarize

One terse recap: the PR URL (draft), the description you wrote, and — if a review ran — what each
round found and fixed, ending either clean or with the open items handed to you. Never undraft,
never merge.

## Notes

- Draft-only and hand-off-pending mirror `review-inbox`: the AI drafts, you sign off.
- Reuses `review-inbox`'s `pr-principal-review.js`, so review comments read in the same terse,
  human voice.
- Requires `gh` authenticated as you.
