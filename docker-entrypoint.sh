#!/bin/sh
# Starts chat-server (background) + web/server.mjs (foreground). Exits the container
# if either process dies so Docker's restart policy recovers both.
set -e

# Start the BFF in the background. Capture its PID so we can monitor it.
node --experimental-transform-types apps/chat-server/src/index.ts &
CHAT_PID=$!

# Watchdog: if the BFF dies, kill the foreground process so the container exits.
( wait "$CHAT_PID"; kill "$$" 2>/dev/null ) &

# Start the web server in the foreground. Its exit code becomes the container exit code.
exec node web/server.mjs
