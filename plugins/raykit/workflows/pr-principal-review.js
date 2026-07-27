export const meta = {
  name: 'pr-principal-review',
  description: 'Principal-engineer review of one or more PRs, depth scaled to diff size, adversarially verified, returning terse human-voice comments + an approve/request-changes/comment recommendation per PR',
  phases: [
    { title: 'Context', detail: 'what each PR is for + what the last round asked' },
    { title: 'Review' },
    { title: 'Verify' },
    { title: 'Summarize' },
  ],
}

// args: array of PR objects: [{ number, repo, additions, files, title }]
//       or { prs: [...], findings: { "<pr number>": [ ...precomputed findings... ] } }
//         — pass `findings` to re-use an earlier run's review passes and only redo the
//           prior-round triage / dedupe / summary stages.
// Returns: [{ pr, repo, brief, recommendation, summary, body,
//             comments:[{path,line,body,severity}], replies:[{thread_id,body,resolve,status,gist}],
//             dropped:[{comment,thread_id,reason}], bodyOnly:[] }]

const PRS = Array.isArray(args) ? args : (args && args.prs) || []
if (!PRS.length) return { error: 'no PRs passed in args', prs: [] }
const PRECOMPUTED = (!Array.isArray(args) && args && args.findings) || {}

const STYLE = `Write every comment the way a senior engineer drops an inline note: direct, minimal, human — indistinguishable from a person. State the concern in as few words as convey it, add the fix only if it isn't obvious. No severity labels, no "Failure:/Fix:" scaffolding, no preamble, and NEVER any footer about being automated or AI-generated. One to two sentences. Reference the exact symbol/line inline (it's already anchored).`

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['severity', 'category', 'file', 'line', 'comment'],
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          comment: { type: 'string', description: 'the terse, human-voice inline comment to post verbatim' },
        },
      },
    },
  },
}
const BRIEF_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['purpose', 'mechanism', 'ticket', 'affects', 'gaps'],
  properties: {
    purpose: { type: 'string', description: 'the problem this PR solves and why it exists — plain language, no diff restatement, 1-2 sentences' },
    mechanism: { type: 'string', description: 'how it solves it — the approach, 1-2 sentences' },
    ticket: { type: 'string', description: 'ticket/issue key + URL if discoverable from the title, branch, body or commits; empty string if none' },
    affects: { type: 'string', description: 'which surface/users this touches and what breaks for them if it is wrong — one sentence' },
    gaps: { type: 'string', description: 'anything the description claims that the diff does not do, or context only the author has; empty string if none' },
  },
}
const PRIOR_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['threads'],
  properties: {
    threads: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['thread_id', 'path', 'gist', 'status', 'reply', 'resolve'],
        properties: {
          thread_id: { type: 'string', description: 'the GraphQL node id (PRRT_…) of the review thread' },
          path: { type: 'string' },
          gist: { type: 'string', description: 'one line: what the original comment asked for' },
          status: { type: 'string', enum: ['fixed', 'partial', 'not_fixed', 'stale'] },
          reply: { type: 'string', description: 'the reply to stage on the thread, in the house voice; empty string to say nothing' },
          resolve: { type: 'boolean', description: 'true only when status is fixed' },
        },
      },
    },
  },
}
const DEDUPE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['duplicates'],
  properties: {
    duplicates: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['index', 'thread_id', 'reason'],
        properties: {
          index: { type: 'number', description: 'index into the candidate findings array' },
          thread_id: { type: 'string', description: 'the existing thread that already covers it' },
          reason: { type: 'string' },
        },
      },
    },
  },
}
const BODY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['body'],
  properties: { body: { type: 'string', description: 'the submit-ready review body' } },
}
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'corrected_severity', 'reason'],
  properties: {
    verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'] },
    corrected_severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    reason: { type: 'string' },
  },
}

function depthFor(pr) {
  const a = pr.additions || 0, f = pr.files || 0
  if (a > 1500 || f > 25) return 'heavy'
  if (a > 300 || f > 6) return 'medium'
  return 'light'
}

const DIMENSIONS = {
  light: [{ key: 'all', focus: 'everything that matters — correctness, security/tenancy/authz, data integrity, error handling, tests, and (if a UI PR) state/error-surfacing' }],
  medium: [
    { key: 'correctness', focus: 'correctness, logic, unhandled union/Optional branches, off-by-one, wrong defaults' },
    { key: 'security-tenancy', focus: 'security, authorization (must fail closed), multi-tenant isolation, injection/SSRF, untrusted LLM output' },
    { key: 'reliability-fe', focus: 'error handling & observability (routes wrapped + errors reported), concurrency/data-integrity, and — if a UI PR — state correctness, backend-error surfacing to the user, a11y; plus test coverage' },
  ],
  heavy: [
    { key: 'correctness', focus: 'correctness, logic, unhandled union/Optional branches, edge cases' },
    { key: 'security-tenancy', focus: 'security, authorization (fail closed), multi-tenant isolation, injection/SSRF, untrusted LLM output' },
    { key: 'data-integrity', focus: 'transactions, idempotency, event/log durability & ordering, concurrent writers, partial-failure' },
    { key: 'error-obs', focus: 'error handling & observability — routes wrapped + notice_error, nothing swallowed silently (fail loud), backend errors surfaced to the UI' },
    { key: 'api-tests', focus: 'API/contract design & versioning, error contracts, and test coverage adequacy' },
    { key: 'frontend', focus: 'frontend only (skip if no UI files): component state, error surfacing, a11y, auth-token handling, no client secrets' },
  ],
}

function reviewPrompt(pr, dim) {
  return `You are a principal engineer reviewing PR #${pr.number} in ${pr.repo}: "${pr.title || ''}".

Gather the change and context yourself:
- Diff:        gh pr diff ${pr.number} --repo ${pr.repo}
- Files:       gh pr diff ${pr.number} --repo ${pr.repo} | grep '^diff --git'
- Metadata:    gh pr view ${pr.number} --repo ${pr.repo} --json title,body,baseRefName,headRefName,mergeStateStatus
- Full files / context: gh api "repos/${pr.repo}/contents/<path>?ref=<headRefName>" -q .content | base64 -d, or read callers/imports as needed.

Focus this pass on: ${dim.focus}.

Flag only real, defensible defects — every one needs an exact file:line and a concrete failure (inputs/state -> wrong result). No style/format/lint nits, no invented issues to fill a quota. If a dimension is clean, return no findings for it.

For each finding, write the \`comment\` field as the actual inline comment to post. ${STYLE}

You are read-only. Do not modify files. Return via the structured tool.`
}

function briefPrompt(pr) {
  return `Explain what PR #${pr.number} in ${pr.repo} ("${pr.title || ''}") is FOR, so a reviewer who has never seen this work can orient in ten seconds.

Read the intent, not just the code:
- Metadata:  gh pr view ${pr.number} --repo ${pr.repo} --json title,body,baseRefName,headRefName,author,labels
- Commits:   gh pr view ${pr.number} --repo ${pr.repo} --json commits
- Diff:      gh pr diff ${pr.number} --repo ${pr.repo}
- If the title, branch, body or commits reference a ticket (e.g. ABC-123, #456), follow it: try any
  issue-tracker tools available to you (search for them first), else \`gh issue view\`, and pull the
  stated problem. Leave \`ticket\` empty rather than guessing a URL.

Write for someone deciding how hard to look at this, in plain language. Do NOT restate the diff or
list changed files — the reviewer can read those. Say what problem exists in the world, why this
change is the answer, and what it puts at risk. If the PR body is thin or contradicts the diff, say
so in \`gaps\` — that's the most useful thing you can surface.

You are read-only. Do not modify files. Return via the structured tool.`
}

function priorPrompt(pr) {
  return `PR #${pr.number} in ${pr.repo} may be a RE-REVIEW. Work out what your own previous round asked for and which of it the author actually did.

1. Who you are:  ME=$(gh api user -q .login)
2. Pull every review thread with its node id and resolution state:

gh api graphql -f query='{repository(owner:"OWNER",name:"REPO"){pullRequest(number:${pr.number}){
  reviewThreads(first:100){nodes{ id isResolved isOutdated path line
    comments(first:20){nodes{ databaseId author{login} createdAt body }}}}}}}'

   (split ${pr.repo} into OWNER/REPO). Keep ONLY threads whose FIRST comment is authored by ME —
   those are your findings. Ignore other reviewers' threads and bot threads entirely.

3. Skip a thread if you already replied after the author's last comment on it — you handled that
   in a previous round and must not ack it twice. Return nothing for those.

4. For each remaining thread, read the CURRENT code and judge what happened. The author resolving a
   thread is a claim, not evidence — verify it:
   gh api "repos/${pr.repo}/contents/<path>?ref=$(gh pr view ${pr.number} --repo ${pr.repo} --json headRefName -q .headRefName)" -q .content | base64 -d
   Read the author's replies too (they often explain a deliberate deferral).

   - fixed      — the concern is genuinely gone in the current code. \`resolve\`: true.
   - partial    — they changed something but the defect survives, or the fix introduced a new one
                  (e.g. the guard you asked for exists but uses the wrong predicate). \`resolve\`: false.
                  \`reply\` must say concretely what still breaks. This is the highest-value case.
   - not_fixed  — untouched, or they replied "later" without changing it. \`resolve\`: false.
   - stale      — the code it referred to is gone or the point is moot. \`reply\`: "", \`resolve\`: false.

5. Write \`reply\` as the actual comment to stage on that thread. ${STYLE} For \`fixed\`, one short
   line confirming it — no praise inflation, no restating their own fix back at them. Never claim
   something is fixed that you could not verify in the code; call that \`partial\` instead.

You are read-only. Do not modify files or post anything. Return via the structured tool.`
}

function dedupePrompt(pr, prior, findings) {
  return `Re-review hygiene for PR #${pr.number} in ${pr.repo}: drop candidate findings that your previous round already raised, so this round posts only what's NEW.

Existing threads from your last round (already being replied to on the thread itself):
${JSON.stringify(prior.map((t) => ({ thread_id: t.thread_id, path: t.path, status: t.status, gist: t.gist })), null, 1)}

Candidate findings from this round:
${JSON.stringify(findings.map((f, i) => ({ index: i, file: f.file, line: f.line, comment: f.comment })), null, 1)}

Mark a candidate as a duplicate when it is the SAME underlying defect as an existing thread, even if
the line moved or the wording differs — the author will read the thread reply instead, and a second
copy on a new line is noise.

Do NOT mark it a duplicate when it is a genuinely different defect that merely lives in the same
function or was introduced by their attempted fix. Those are the findings a re-review exists to
surface; losing them is worse than a little redundancy. When torn, keep it (omit it from the list).

Read the code if you need to tell the two apart. Return only the duplicates.`
}

function bodyPrompt(pr, rec, kept, prior) {
  const acked = prior.filter((t) => t.status === 'fixed')
  const open = prior.filter((t) => t.status === 'partial' || t.status === 'not_fixed')
  return `Write the review body for PR #${pr.number} in ${pr.repo} — the text that lands in GitHub's
"Finish your review" box. It gets submitted as-is, so write it to be sendable with no editing.

Recommendation: ${rec.replace('_', ' ')}
New findings this round (${kept.length}), already posted inline:
${JSON.stringify(kept.map((f) => ({ severity: f.severity, file: f.file, line: f.line, comment: f.comment })), null, 1)}
${prior.length ? `
This is a re-review. Confirmed fixed since last round (${acked.length}): ${JSON.stringify(acked.map((t) => t.gist))}
Still open from last round (${open.length}): ${JSON.stringify(open.map((t) => ({ status: t.status, gist: t.gist })))}` : ''}

Rules:
- Open with the verdict in your own words — GitHub cannot preselect the approve/request-changes
  radio, so the body has to carry it. One short line.
- If this is a re-review, credit what got fixed BEFORE the new problems, in one line, aggregate
  ("all five from last round are in — one guard landed with the wrong predicate, see the thread").
  Do not enumerate what's already visible on the threads.
- Then the shape of what's new: the pattern the findings share, not a list of them. They're inline;
  the body says why they add up to this verdict.
- ${STYLE.replace('every comment', 'this body').replace('inline note', 'review summary')}
- No headings, no bullet lists unless there are genuinely 3+ unrelated clusters. 2-5 sentences.
- Never mention being automated or AI-generated.

Return via the structured tool.`
}

function verifyPrompt(pr, f) {
  return `Adversarially verify one review finding against the ACTUAL code of PR #${pr.number} in ${pr.repo}. Try to REFUTE it.

Finding: ${JSON.stringify({ file: f.file, line: f.line, severity: f.severity, comment: f.comment })}

Read the real code (gh pr diff ${pr.number} --repo ${pr.repo}; gh api "repos/${pr.repo}/contents/${f.file}?ref=<headRefName>" | base64 -d). CONFIRMED only if you can trace concrete inputs/state to the claimed wrong behavior; REFUTED if the code already handles it, the path is unreachable, or it misreads the code; PLAUSIBLE if real but you can't confirm reachability. Default REFUTED when genuinely uncertain.`
}

const SUBSTANTIVE = /correct|security|tenan|authz|authoriz|integrity|idempot|concurr|durab|event|silent|swallow|fail.?loud|fail.?open|injection|ssrf|leak|provenance|data.?loss|migration/i

function recommend(findings, prior) {
  const all = [...findings, ...prior.filter((t) => t.status === 'partial' || t.status === 'not_fixed').map((t) => ({ severity: 'medium', category: 'unresolved', comment: t.gist }))]
  const sev = (s) => all.some((f) => f.severity === s)
  if (sev('critical') || sev('high')) return 'request_changes'
  const substantiveMed = all.some((f) => f.severity === 'medium' && SUBSTANTIVE.test(`${f.category} ${f.comment}`))
  if (substantiveMed) return 'request_changes'
  if (all.length) return 'comment'
  return 'approve'
}

const results = await pipeline(
  PRS,
  async (pr) => {
    const dims = DIMENSIONS[depthFor(pr)]
    const pre = PRECOMPUTED[String(pr.number)]
    // brief + prior-round triage run alongside the review passes, so they cost no wall-clock
    const [brief, prior, ...passes] = await parallel([
      () => agent(briefPrompt(pr), { label: `context #${pr.number}`, phase: 'Context', schema: BRIEF_SCHEMA }),
      () => agent(priorPrompt(pr), { label: `prior round #${pr.number}`, phase: 'Context', effort: 'high', schema: PRIOR_SCHEMA }),
      ...(pre ? [] : dims.map((d) => () =>
        agent(reviewPrompt(pr, d), { label: `review #${pr.number}:${d.key}`, phase: 'Review', effort: 'high', schema: FINDINGS_SCHEMA })
          .then((r) => (r && r.findings) || [])
      )),
    ])
    // dedup by file:line
    const seen = new Set()
    const findings = (pre || passes.filter(Boolean).flat()).filter((f) => {
      const k = `${f.file}:${f.line}`
      if (seen.has(k)) return false
      seen.add(k); return true
    })
    return { pr, brief, prior: (prior && prior.threads) || [], findings }
  },
  async ({ pr, brief, prior, findings }) => {
    const hi = findings.filter((f) => f.severity === 'critical' || f.severity === 'high')
    const [verified, dedupe] = await parallel([
      () => parallel(hi.map((f) => () =>
        agent(verifyPrompt(pr, f), { label: `verify #${pr.number}`, phase: 'Verify', effort: 'high', schema: VERDICT_SCHEMA })
          .then((v) => ({ ...f, verify: v }))
      )),
      () => (prior.length && findings.length
        ? agent(dedupePrompt(pr, prior, findings), { label: `dedupe #${pr.number}`, phase: 'Verify', effort: 'high', schema: DEDUPE_SCHEMA })
        : Promise.resolve({ duplicates: [] })),
    ])
    const lows = findings.filter((f) => f.severity !== 'critical' && f.severity !== 'high').map((f) => ({ ...f, verify: null }))
    const survived = [...(verified || []).filter(Boolean), ...lows].filter((f) => !f.verify || f.verify.verdict !== 'REFUTED')
      .map((f) => (f.verify && f.verify.corrected_severity ? { ...f, severity: f.verify.corrected_severity } : f))

    // drop findings the last round already raised — the thread reply covers them
    const dupes = new Map(((dedupe && dedupe.duplicates) || []).map((d) => [findings[d.index] && `${findings[d.index].file}:${findings[d.index].line}`, d]))
    const dropped = [], kept = []
    for (const f of survived) {
      const d = dupes.get(`${f.file}:${f.line}`)
      if (d) dropped.push({ comment: f.comment, thread_id: d.thread_id, reason: d.reason })
      else kept.push(f)
    }
    const rank = { critical: 0, high: 1, medium: 2, low: 3 }
    kept.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9))

    const rec = recommend(kept, prior)
    const replies = prior.filter((t) => t.reply && t.reply.trim())
    const written = await agent(bodyPrompt(pr, rec, kept, prior), { label: `summarize #${pr.number}`, phase: 'Summarize', schema: BODY_SCHEMA })
    const counts = ['critical', 'high', 'medium', 'low'].map((s) => `${kept.filter((f) => f.severity === s).length} ${s}`).filter((x) => !x.startsWith('0')).join(', ')
    const acked = prior.filter((t) => t.status === 'fixed').length
    return {
      pr: pr.number, repo: pr.repo, title: pr.title,
      brief: brief || null,
      recommendation: rec,
      summary: [
        kept.length ? `${counts} new — inline.` : 'Nothing new.',
        prior.length ? `${acked}/${prior.length} from last round fixed.` : null,
        dropped.length ? `${dropped.length} repeat(s) folded into existing threads.` : null,
      ].filter(Boolean).join(' '),
      body: (written && written.body) || `Recommend: ${rec.replace('_', ' ')}. ${kept.length ? `${counts} new — inline.` : 'Nothing new.'}`,
      comments: kept.map((f) => ({ path: f.file, line: f.line, body: f.comment, severity: f.severity })),
      replies: replies.map((t) => ({ thread_id: t.thread_id, body: t.reply, resolve: !!t.resolve, status: t.status, gist: t.gist, path: t.path })),
      dropped,
      bodyOnly: [],
    }
  }
)

return results.filter(Boolean)
