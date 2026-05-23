#!/usr/bin/env bash
# Test harness for branch-name-check.sh.
#
# Pipes synthetic PreToolUse JSON payloads through the validator and asserts
# that the response either denies (with a permissionDecision of "deny") or
# passes through (empty stdout, exit 0). Run with:
#
#   bash .claude/hooks/test-branch-name-check.sh
#
# Adding a case: pick assert_deny or assert_pass, give it a label and the
# JSON payload to send on stdin. Keep payloads single-line for readability.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
TARGET="$SCRIPT_DIR/branch-name-check.sh"

if [[ ! -x "$TARGET" ]]; then
  echo "FAIL: $TARGET is not executable" >&2
  exit 1
fi

pass=0
fail=0

assert_deny() {
  local label="$1" payload="$2"
  local out
  out=$(printf '%s' "$payload" | "$TARGET")
  if printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision == "deny"' > /dev/null 2>&1; then
    printf '  PASS  %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '  FAIL  %s\n        expected deny, got: %s\n' "$label" "$out"
    fail=$((fail + 1))
  fi
}

assert_pass() {
  local label="$1" payload="$2"
  local out
  out=$(printf '%s' "$payload" | "$TARGET")
  if [[ -z "$out" ]]; then
    printf '  PASS  %s\n' "$label"
    pass=$((pass + 1))
  else
    printf '  FAIL  %s\n        expected empty output, got: %s\n' "$label" "$out"
    fail=$((fail + 1))
  fi
}

echo "== Bash matcher =="
assert_pass "valid: git checkout -b feat/foo-bar" \
  '{"tool_name":"Bash","tool_input":{"command":"git checkout -b feat/foo-bar"}}'
assert_pass "valid: feat/tNNN-slug form" \
  '{"tool_name":"Bash","tool_input":{"command":"git checkout -b feat/t004-viewport-fix"}}'
assert_deny "invalid: ticket-id branch (WORK-123)" \
  '{"tool_name":"Bash","tool_input":{"command":"git checkout -b WORK-123"}}'
assert_deny "invalid: wrong type (feature/...)" \
  '{"tool_name":"Bash","tool_input":{"command":"git checkout -b feature/foo"}}'
assert_pass "valid: git switch -c fix/null-sender" \
  '{"tool_name":"Bash","tool_input":{"command":"git switch -c fix/null-sender"}}'
assert_deny "invalid: git switch -c feature/foo" \
  '{"tool_name":"Bash","tool_input":{"command":"git switch -c feature/foo"}}'
assert_pass "valid: worktree add -b chore/biome" \
  '{"tool_name":"Bash","tool_input":{"command":"git worktree add ../wt -b chore/biome"}}'
assert_pass "valid: worktree add -B chore/biome (force form)" \
  '{"tool_name":"Bash","tool_input":{"command":"git worktree add ../wt -B chore/biome"}}'
assert_deny "invalid: worktree add -b RPT-9999" \
  '{"tool_name":"Bash","tool_input":{"command":"git worktree add ../wt -b RPT-9999"}}'
assert_pass "valid: git branch test/new-thing" \
  '{"tool_name":"Bash","tool_input":{"command":"git branch test/new-thing"}}'
assert_deny "invalid: git branch WORK-123" \
  '{"tool_name":"Bash","tool_input":{"command":"git branch WORK-123"}}'
assert_pass "ignored: git branch -d old" \
  '{"tool_name":"Bash","tool_input":{"command":"git branch -d old"}}'
assert_pass "ignored: git branch --list" \
  '{"tool_name":"Bash","tool_input":{"command":"git branch --list"}}'
assert_pass "ignored: unrelated command (ls -la)" \
  '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}'
assert_pass "valid: force form git checkout -B feat/foo" \
  '{"tool_name":"Bash","tool_input":{"command":"git checkout -B feat/foo"}}'
assert_pass "valid: force form git switch -C fix/bar" \
  '{"tool_name":"Bash","tool_input":{"command":"git switch -C fix/bar"}}'
assert_deny "invalid: force form with bad name (checkout -B)" \
  '{"tool_name":"Bash","tool_input":{"command":"git checkout -B WORK-1"}}'
assert_deny "invalid: leading dash in slug (feat/-foo)" \
  '{"tool_name":"Bash","tool_input":{"command":"git checkout -b feat/-foo"}}'
assert_deny "invalid: trailing dash in slug (chore/bar-)" \
  '{"tool_name":"Bash","tool_input":{"command":"git checkout -b chore/bar-"}}'

echo "== EnterWorktree matcher =="
assert_pass "valid: .branch field" \
  '{"tool_name":"EnterWorktree","tool_input":{"branch":"feat/cdp-reconnect"}}'
assert_deny "invalid: uppercase in name" \
  '{"tool_name":"EnterWorktree","tool_input":{"branch":"feat/CDPReconnect"}}'
assert_pass "valid: .branchName fallback" \
  '{"tool_name":"EnterWorktree","tool_input":{"branchName":"fix/viewport-offset"}}'
assert_deny "invalid: .branchName fallback with bad name" \
  '{"tool_name":"EnterWorktree","tool_input":{"branchName":"WORK-42"}}'
assert_pass "valid: .name fallback" \
  '{"tool_name":"EnterWorktree","tool_input":{"name":"docs/runbook"}}'
assert_deny "invalid: .name fallback with bad name" \
  '{"tool_name":"EnterWorktree","tool_input":{"name":"feature/Foo"}}'

echo
printf 'Results: %d pass, %d fail\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
