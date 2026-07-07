// Atomic file write: write to a temp sibling then rename (atomic on the same filesystem), so
// a crash mid-write can't truncate/reset the target JSON (settings, push subs, notifications,
// Slack registry + sweep state). Shared by web/server.mjs and main.js. `fs` is injectable for
// tests. A leftover `.tmp` from a prior crash is simply overwritten on the next write.
const fs = require("fs")

function atomicWriteFileSync(path, data, deps = {}) {
  const writeFileSync = deps.writeFileSync || fs.writeFileSync
  const renameSync = deps.renameSync || fs.renameSync
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

module.exports = { atomicWriteFileSync }
