---
name: pr-monitor
description: Monitor a GitHub PR until approved — poll CI, read review comments, address blocking/should-fix findings, push fixes, re-poll. Use when user says "monitor the PR", "watch the PR", "address reviews", or "push until approved".
---

# pr-monitor

Polls CI + reviews on a PR and iterates until approved or stuck.

## Quick start

```
/pr-monitor          # uses current branch's open PR
/pr-monitor 54       # explicit PR number
```

## Loop

Repeat until `reviewDecision == APPROVED` or you determine you're stuck:

### 1. Check state

```bash
gh pr checks <PR> 2>&1
gh pr view <PR> --json state,reviewDecision,reviews
```

### 2. If all CI checks pass and reviewDecision is APPROVED → done.

### 3. If CI checks are pending → wait, then re-check.

Use `sleep 60` between polls. Never spin in a tight loop.

### 4. If CI checks fail

Read the failed job log:

```bash
gh run view <run-id> --log-failed 2>&1 | head -80
```

Fix locally → `pnpm test && pnpm typecheck && pnpm check` → commit → push.

Commit message: `fix(<scope>): <what>` — no mention of "review" or "CI".

### 5. If reviewDecision is CHANGES_REQUESTED

Read every review comment:

```bash
gh pr view <PR> --json reviews --jq '.reviews[] | {state, body, submitted: .submittedAt}'
```

Also fetch inline comments if needed:

```bash
gh api repos/:owner/:repo/pulls/<PR>/comments --jq '.[] | {path, line, body}'
```

Triage findings:
- **Blocking** — fix before pushing.
- **Should fix** — fix in the same commit if straightforward; note if genuinely out of scope.
- **Nit** — apply if trivial (one-liner); skip otherwise.

Run `pnpm test && pnpm typecheck && pnpm check` after changes. Commit and push.

### 6. After pushing fixes → go to step 1.

## Guardrails

- Never force-push.
- Never skip hooks (`--no-verify`).
- Cap at 5 push iterations. If review still blocked after 5, surface the blocker to the user.
- If the same finding recurs after a fix, surface it instead of looping again.
- Don't address nits speculatively — only what the reviewer called out.
