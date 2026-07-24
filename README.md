# raykit

Alexander Ray's personal Claude Code toolkit, distributed as a plugin. Install it and its
tools show up under the `/raykit:` namespace. More get added over time.

## Tools

### `/raykit:review-inbox`

Reviews the PRs you're tagged on, then hands them to **you** to sign off. It:

- discovers open, non-draft PRs where **you** are a requested reviewer (across all repos),
- skips anything you already left a pending review on (re-reviews only when you're re-pinged),
- runs a principal-engineer review whose depth scales to the diff (one reviewer for small PRs,
  a wider fan-out + adversarial verification for large ones),
- posts **one pending review per PR** — author-only, never submitted — with terse, human-voice
  inline comments and an **approve / request-changes / comment** recommendation,
- **then opens each reviewed PR in your browser with the pending comments loaded**, so you read
  every draft comment in context and submit, edit, or delete it yourself.

**That last step is the point.** The AI drafts; nothing goes out until a human reviews the
pending comments in the browser and hits submit. It never submits a review, never comments as
you on someone else's PR, and never pushes code — it just gets the draft in front of you.

## Install

```
/plugin marketplace add Alex-ray/raykit
/plugin install raykit@raykit
/reload-plugins
```

Then run `/raykit:review-inbox` (or just ask Claude to "review my PRs").

## Requirements

- [`gh`](https://cli.github.com) authenticated as you (`gh auth login`). Used to discover PRs,
  read diffs, and post pending reviews.
- macOS for the auto-open step (uses `open`); on other platforms the PR URLs are printed instead.

## Safety

Tools here only ever create **pending** reviews (visible to you alone) and open them for your
review. Nothing is submitted, no comments are posted as you on others' PRs, and no code is pushed.
