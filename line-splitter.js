// Reassembles newline-delimited frames (NDJSON) from a chunked stream — the web
// build's streaming input channel writes one JSON frame per line into a long-lived
// HTTP request body, and TCP chunk boundaries don't respect lines. Pure; CommonJS
// so web/server.mjs can import it. Tested by line-splitter.test.ts.

function createLineSplitter() {
  let buf = ""
  return {
    /** Feed a chunk; return the complete lines it completed (blank lines dropped). */
    push(chunk) {
      buf += chunk
      const parts = buf.split("\n")
      buf = parts.pop() ?? "" // last element is the incomplete remainder
      return parts.filter((line) => line.length > 0)
    },
  }
}

module.exports = { createLineSplitter }
