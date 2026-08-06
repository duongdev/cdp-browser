#!/usr/bin/env bash
# Regression check for the self-referential symlink that stopped electron-builder.
#
# `.scratch -> .scratch` was committed in 492c9f2 and packaging the repo root then died
# with `ELOOP: too many symbolic links encountered`. Two independent causes:
#
#   1. .gitignore said `.scratch/` — the trailing slash matches a DIRECTORY only, so a
#      symlink of that name was tracked instead of ignored
#   2. e2e-link-worktree.sh created the link without checking source and target resolve
#      to different paths
#
# Nothing here EXECUTES the linker: it rewrites the checkout it is run from, so calling
# it with a probe E2E_MAIN replaced this repo's own .claude files with links into a temp
# dir that then vanished. The guard is checked by evaluating its predicate directly.
set -uo pipefail
cd "$(dirname "$0")/.."

fails=0
check() {
  if [ "$2" -eq 0 ]; then echo "  PASS  $1"; else echo "  FAIL  $1"; fails=$((fails + 1)); fi
}

echo "1. git ignores .scratch whatever kind of file it is"
git check-ignore -q .scratch
check ".gitignore matches the name, not only a directory" $?

echo "2. the linker's guard detects two paths that resolve to the same place"
probe=$(mktemp -d)
mkdir -p "$probe/real/x"
ln -s "$probe/real" "$probe/alias"
src="$probe/alias/x"; dst="$probe/real/x"
same=1
if [ "$(cd "$(dirname "$dst")" && pwd -P)/$(basename "$dst")" = "$(cd "$(dirname "$src")" && pwd -P)/$(basename "$src")" ]; then
  same=0
fi
check "identical paths through a symlinked parent are detected" "$same"
rm -rf "$probe"

echo "3. the guard is actually wired into the linker"
if [ -f .claude/scripts/e2e-link-worktree.sh ]; then
  grep -q 'source and target are the same path' .claude/scripts/e2e-link-worktree.sh
  check "e2e-link-worktree.sh carries the guard" $?
else
  echo "  SKIP  e2e-link-worktree.sh is not present in this checkout"
fi

echo "4. no self-referential symlink is present"
if [ -L .scratch ] && [ "$(readlink .scratch)" = "$PWD/.scratch" ]; then
  check "the bad link is gone" 1
else
  check "the bad link is gone" 0
fi

echo
if [ "$fails" -eq 0 ]; then echo "all checks passed"; else echo "$fails check(s) failed"; exit 1; fi
