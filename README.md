# raykit

Alexander Ray's personal AI plugins for [Claude Code](https://code.claude.com). A
marketplace repo — install what's useful, ignore the rest.

## Plugins

### `review-inbox`

Reviews the PRs you're tagged on. It:

- discovers open, non-draft PRs where **you** are a requested reviewer (across all repos),
- skips anything you already left a pending review on (re-reviews only when you're re-pinged),
- runs a principal-engineer review whose depth scales to the diff (one reviewer for small PRs,
  a wider fan-out + adversarial verification for large ones),
- posts **one pending review per PR** — author-only, never submitted — with terse, human-voice
  inline comments and an **approve / request-changes / comment** recommendation.

Nothing is ever submitted or sent to PR authors; you review the pending drafts and submit them
yourself.

## Install

```
/plugin marketplace add Alex-ray/raykit
/plugin install review-inbox@raykit
/reload-plugins
```

Then run it by asking Claude to **"review my PRs"** / **"check my review queue"** (or the
namespaced skill `/review-inbox:review-inbox`).

## Requirements

- [`gh`](https://cli.github.com) authenticated as you (`gh auth login`). The plugin uses it
  to discover PRs, read diffs, and post pending reviews.

## Safety

The plugin only ever creates **pending** reviews (visible to you alone). It never submits a
review, never comments as you on someone else's PR, and never pushes code.
