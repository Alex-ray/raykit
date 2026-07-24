export const meta = {
  name: 'pr-principal-review',
  description: 'Principal-engineer review of one or more PRs, depth scaled to diff size, adversarially verified, returning terse human-voice comments + an approve/request-changes/comment recommendation per PR',
  phases: [
    { title: 'Review' },
    { title: 'Verify' },
  ],
}

// args: array of PR objects: [{ number, repo, additions, files, title }]
// Returns: [{ pr, repo, recommendation, summary, comments:[{path,line,body}], bodyOnly:[{body}] }]

const PRS = Array.isArray(args) ? args : (args && args.prs) || []
if (!PRS.length) return { error: 'no PRs passed in args', prs: [] }

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

function verifyPrompt(pr, f) {
  return `Adversarially verify one review finding against the ACTUAL code of PR #${pr.number} in ${pr.repo}. Try to REFUTE it.

Finding: ${JSON.stringify({ file: f.file, line: f.line, severity: f.severity, comment: f.comment })}

Read the real code (gh pr diff ${pr.number} --repo ${pr.repo}; gh api "repos/${pr.repo}/contents/${f.file}?ref=<headRefName>" | base64 -d). CONFIRMED only if you can trace concrete inputs/state to the claimed wrong behavior; REFUTED if the code already handles it, the path is unreachable, or it misreads the code; PLAUSIBLE if real but you can't confirm reachability. Default REFUTED when genuinely uncertain.`
}

const SUBSTANTIVE = /correct|security|tenan|authz|authoriz|integrity|idempot|concurr|durab|event|silent|swallow|fail.?loud|fail.?open|injection|ssrf|leak|provenance|data.?loss|migration/i

function recommend(findings) {
  const sev = (s) => findings.some((f) => f.severity === s)
  if (sev('critical') || sev('high')) return 'request_changes'
  const substantiveMed = findings.some((f) => f.severity === 'medium' && SUBSTANTIVE.test(`${f.category} ${f.comment}`))
  if (substantiveMed) return 'request_changes'
  if (findings.length) return 'comment'
  return 'approve'
}

const results = await pipeline(
  PRS,
  async (pr) => {
    const dims = DIMENSIONS[depthFor(pr)]
    const passes = await parallel(
      dims.map((d) => () =>
        agent(reviewPrompt(pr, d), { label: `review #${pr.number}:${d.key}`, phase: 'Review', effort: 'high', schema: FINDINGS_SCHEMA })
          .then((r) => (r && r.findings) || [])
      )
    )
    // dedup by file:line
    const seen = new Set()
    const findings = passes.filter(Boolean).flat().filter((f) => {
      const k = `${f.file}:${f.line}`
      if (seen.has(k)) return false
      seen.add(k); return true
    })
    return { pr, findings }
  },
  async ({ pr, findings }) => {
    const hi = findings.filter((f) => f.severity === 'critical' || f.severity === 'high')
    const verified = await parallel(
      hi.map((f) => () =>
        agent(verifyPrompt(pr, f), { label: `verify #${pr.number}`, phase: 'Verify', effort: 'high', schema: VERDICT_SCHEMA })
          .then((v) => ({ ...f, verify: v }))
      )
    )
    const lows = findings.filter((f) => f.severity !== 'critical' && f.severity !== 'high').map((f) => ({ ...f, verify: null }))
    const kept = [...verified.filter(Boolean), ...lows].filter((f) => !f.verify || f.verify.verdict !== 'REFUTED')
      .map((f) => (f.verify && f.verify.corrected_severity ? { ...f, severity: f.verify.corrected_severity } : f))
    const rank = { critical: 0, high: 1, medium: 2, low: 3 }
    kept.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9))
    const rec = recommend(kept)
    const counts = ['critical', 'high', 'medium', 'low'].map((s) => `${kept.filter((f) => f.severity === s).length} ${s}`).filter((x) => !x.startsWith('0')).join(', ')
    return {
      pr: pr.number, repo: pr.repo, title: pr.title,
      recommendation: rec,
      summary: kept.length ? `${counts} — inline.` : 'Looks good.',
      comments: kept.map((f) => ({ path: f.file, line: f.line, body: f.comment, severity: f.severity })),
      bodyOnly: [],
    }
  }
)

return results.filter(Boolean)
