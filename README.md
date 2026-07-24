 B# raykit

Alexander James Ray's personal Claude Code toolkit, distributed as a plugin. Install it and its
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

## Running it automatically

By default it's on-demand. To have it sweep your queue on a schedule, pick one:

**While Claude is open (simplest):**

```
/loop 4h /raykit:review-inbox
```

Runs every 4 hours until you stop it or close the session. Zero setup, but not durable — it
dies with the session.

**Durable, on a wall-clock schedule (macOS launchd):**

Runs headless whether or not Claude is open, and survives restarts. Create
`~/Library/LaunchAgents/com.raykit.review-inbox.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.raykit.review-inbox</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>claude -p "/raykit:review-inbox" --permission-mode acceptEdits</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>7</integer></dict>
    <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>7</integer></dict>
    <dict><key>Hour</key><integer>17</integer><key>Minute</key><integer>7</integer></dict>
  </array>
</dict>
</plist>
```

Load it: `launchctl load ~/Library/LaunchAgents/com.raykit.review-inbox.plist`
(unload with `launchctl unload ...`).

Requirements/caveats for the headless run:
- `claude` and `gh` on `PATH`, `gh` authenticated as you.
- A permission mode that won't block on prompts. `--permission-mode acceptEdits` covers most;
  a fully unattended run may need a scoped allowlist or `--dangerously-skip-permissions` — only
  do that if you understand it's granting the run broad tool access.
- It posts **pending** reviews and opens tabs; nothing is submitted, so an unattended run is
  safe in that it can't send anything to authors on its own.

## Requirements

- [`gh`](https://cli.github.com) authenticated as you (`gh auth login`). Used to discover PRs,
  read diffs, and post pending reviews.
- macOS for the auto-open step (uses `open`); on other platforms the PR URLs are printed instead.

## Safety

Tools here only ever create **pending** reviews (visible to you alone) and open them for your
review. Nothing is submitted, no comments are posted as you on others' PRs, and no code is pushed.
