#!/usr/bin/env bash
# Build CDP Browser and install it into /Applications.
# Produces an unsigned, unpacked .app (electron-builder --dir) — no dmg/zip — and
# copies it over any existing install. Quarantine is stripped so Gatekeeper doesn't
# block the locally-built, unsigned bundle.
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="CDP Browser"
DEST="/Applications/${APP_NAME}.app"

echo "==> Building renderer and packaging ${APP_NAME}.app…"
npm run dist:dir

# electron-builder writes to release/<mac|mac-arm64|mac-universal>/. Pick the
# newest matching bundle in case stale builds from other targets linger.
APP_PATH="$(find release -maxdepth 2 -name "${APP_NAME}.app" -type d \
  -exec stat -f '%m %N' {} \; | sort -rn | head -n1 | cut -d' ' -f2-)"
if [[ -z "${APP_PATH}" ]]; then
  echo "error: could not find built ${APP_NAME}.app under release/" >&2
  exit 1
fi
echo "==> Built: ${APP_PATH}"

# Quit a running copy of the installed app so the replace can't hit a busy bundle.
osascript -e "quit app \"${APP_NAME}\"" >/dev/null 2>&1 || true
sleep 1

echo "==> Installing to ${DEST}…"
rm -rf "${DEST}"
cp -R "${APP_PATH}" "${DEST}"
xattr -cr "${DEST}" 2>/dev/null || true

echo "==> Done. Launch with: open -a \"${APP_NAME}\""
