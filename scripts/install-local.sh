#!/usr/bin/env bash
# Build both apps and install them into /Applications:
#   • CDP Browser  — the full browser (main.js)
#   • CDP Chats    — the standalone chat shell (chat-main.js), points at a web
#                    server's /chat (set CHAT_SERVER_URL to override the default).
# Both are unsigned, unpacked .app bundles (electron-builder --dir) — no dmg/zip.
# Quarantine is stripped so Gatekeeper doesn't block the locally-built bundles.
set -euo pipefail

cd "$(dirname "$0")/.."

# install_app <product-name> <release-dir>
# Finds the newest matching .app under <release-dir> and copies it over any
# existing install, stripping quarantine.
install_app() {
  local app_name="$1" release_dir="$2"
  local dest="/Applications/${app_name}.app"

  local app_path
  app_path="$(find "${release_dir}" -maxdepth 2 -name "${app_name}.app" -type d \
    -exec stat -f '%m %N' {} \; | sort -rn | head -n1 | cut -d' ' -f2-)"
  if [[ -z "${app_path}" ]]; then
    echo "error: could not find built ${app_name}.app under ${release_dir}/" >&2
    exit 1
  fi
  echo "==> Built: ${app_path}"

  # Quit a running copy so the replace can't hit a busy bundle.
  osascript -e "quit app \"${app_name}\"" >/dev/null 2>&1 || true
  sleep 1

  echo "==> Installing to ${dest}…"
  rm -rf "${dest}"
  cp -R "${app_path}" "${dest}"
  xattr -cr "${dest}" 2>/dev/null || true
}

echo "==> Building CDP Browser.app…"
npm run dist:dir
install_app "CDP Browser" "release"

echo "==> Building CDP Chats.app…"
npm run dist:chat:dir
install_app "CDP Chats" "release-chat"

echo "==> Done."
echo "    Launch:  open -a \"CDP Browser\"   /   open -a \"CDP Chats\""
