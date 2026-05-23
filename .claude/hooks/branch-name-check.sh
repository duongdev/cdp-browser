#!/usr/bin/env bash
# PreToolUse hook: enforce branch naming convention.
# Required format: <type>/<short-kebab-name> or <type>/t<NNN>-<short-kebab-name>
# where <type> is one of feat|fix|refactor|docs|chore|test|spike.
# No private PM ticket IDs, no uppercase, no trailing dashes.
#
# Triggers a "deny" permission decision for:
#   - EnterWorktree tool calls with a non-conforming branch
#   - Bash commands that create a branch: git checkout -b, git switch -c,
#     git branch <name>, git worktree add -b|-B <branch>
#
# Read-only branch operations (git branch -d, --list, etc.) are not affected.
#
# Known gaps (intentionally not matched — add a case below if needed):
#   - git switch --create <branch>        (long form of -c)
#   - git checkout --orphan <branch>      (rare; creates a parentless branch)
#   - git branch --track <branch> <up>    (the leading --track flag makes the
#                                          branch name slip past the
#                                          [^-[:space:]] guard)
#
# EnterWorktree field resolution: reads .tool_input.branch first,
# then .tool_input.branchName, then .tool_input.name. If none present,
# silently passes through.

set -euo pipefail

# Fail-open if jq is missing: a missing tool here would otherwise abort under
# set -e and Claude Code would treat the non-zero exit as a deny, blocking
# every Bash and EnterWorktree call in the session.
command -v jq > /dev/null 2>&1 || exit 0

# Slug rules: start and end with [a-z0-9]; internal dashes allowed. Rejects
# `feat/-foo` and `chore/bar-`. Also permits the tNNN prefix form.
PATTERN='^(feat|fix|refactor|docs|chore|test|spike)/[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
GUIDANCE='Branch names must match <type>/<short-kebab-name> where <type> is one of: feat, fix, refactor, docs, chore, test, spike. Lowercase kebab-case only. Task-ID prefix (tNNN) is allowed: feat/t004-viewport-fix. Never include private PM ticket IDs. See CLAUDE.md > Branch naming.'

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""')

deny() {
  local branch="$1"
  jq -n \
    --arg b "$branch" \
    --arg msg "$GUIDANCE" \
    '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: ("Invalid branch name \"" + $b + "\". " + $msg)
      }
    }'
  exit 0
}

check() {
  local branch="$1"
  [[ -z "$branch" ]] && return 0
  if ! [[ "$branch" =~ $PATTERN ]]; then
    deny "$branch"
  fi
}

case "$tool" in
  EnterWorktree)
    branch=$(printf '%s' "$input" | jq -r '.tool_input.branch // .tool_input.branchName // .tool_input.name // ""')
    check "$branch"
    ;;
  Bash)
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""')
    # git checkout -b <branch>
    if [[ "$cmd" =~ git[[:space:]]+checkout[[:space:]]+-[bB][[:space:]]+([^[:space:]]+) ]]; then
      check "${BASH_REMATCH[1]}"
    fi
    # git switch -c <branch>
    if [[ "$cmd" =~ git[[:space:]]+switch[[:space:]]+-[cC][[:space:]]+([^[:space:]]+) ]]; then
      check "${BASH_REMATCH[1]}"
    fi
    # git worktree add -b <branch> ... / -B <branch>
    if [[ "$cmd" =~ git[[:space:]]+worktree[[:space:]]+add[[:space:]]+(.*[[:space:]])?-[bB][[:space:]]+([^[:space:]]+) ]]; then
      check "${BASH_REMATCH[2]}"
    fi
    # git branch <branch> (creation form: first non-flag arg after "branch")
    if [[ "$cmd" =~ git[[:space:]]+branch[[:space:]]+([^-[:space:]][^[:space:]]*) ]]; then
      check "${BASH_REMATCH[1]}"
    fi
    ;;
esac

exit 0
