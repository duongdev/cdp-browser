#!/usr/bin/env bash
# Build both apps and install them into /Applications, in parallel:
#   • CDP Browser  — the full browser (main.js)
#   • CDP Chats    — the standalone chat shell (chat-main.js), points at a web
#                    server's /chat (set CHAT_SERVER_URL to override the default).
# Both are unsigned, unpacked .app bundles (electron-builder --dir) — no dmg/zip.
# Quarantine is stripped so Gatekeeper doesn't block the locally-built bundles.
# Each app: build → quit if running → install → reopen ONLY if it was running.
set -uo pipefail

cd "$(dirname "$0")/.."

# build_and_install <product-name> <npm-build-script> <release-dir>
build_and_install() {
  local name="$1" script="$2" release_dir="$3"
  local dest="/Applications/${name}.app"

  # Was it running before we touch it? (Reopen later only if so.)
  local was_running=0
  pgrep -f "/Applications/${name}.app/Contents/MacOS/" >/dev/null 2>&1 && was_running=1

  echo "==> [${name}] building…"
  if ! npm run "${script}"; then
    echo "error: [${name}] build failed" >&2
    return 1
  fi

  # electron-builder writes to <release-dir>/<mac|mac-arm64|…>/. Pick the newest match.
  local app_path
  app_path="$(find "${release_dir}" -maxdepth 2 -name "${name}.app" -type d \
    -exec stat -f '%m %N' {} \; | sort -rn | head -n1 | cut -d' ' -f2-)"
  if [[ -z "${app_path}" ]]; then
    echo "error: [${name}] could not find built .app under ${release_dir}/" >&2
    return 1
  fi

  # Quit a running copy so the replace can't hit a busy bundle.
  osascript -e "quit app \"${name}\"" >/dev/null 2>&1 || true
  sleep 1

  echo "==> [${name}] installing to ${dest}…"
  rm -rf "${dest}"
  cp -R "${app_path}" "${dest}"
  xattr -cr "${dest}" 2>/dev/null || true

  # Reopen only if it had been running when this script started.
  if [[ "${was_running}" -eq 1 ]]; then
    echo "==> [${name}] reopening (was running)…"
    open "${dest}"
  fi
  echo "==> [${name}] done."
}

# Both apps fully in parallel (build + swap + reopen each in its own subshell).
build_and_install "CDP Browser" "dist:dir" "release" &
pid_browser=$!
build_and_install "CDP Chats" "dist:chat:dir" "release-chat" &
pid_chat=$!

status=0
wait "${pid_browser}" || status=1
wait "${pid_chat}" || status=1

if [[ "${status}" -ne 0 ]]; then
  echo "==> One or more installs failed." >&2
  exit 1
fi
echo "==> All done.  Launch:  open -a \"CDP Browser\"   /   open -a \"CDP Chats\""
