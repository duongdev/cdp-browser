// Pure request-payload shape guards (t099). A malformed/undecryptable body is rejected upstream
// (400); these guard the SHAPE of the dangerous mutation payloads so a syntactically-valid but
// wrong body (e.g. an empty {} from a masked decrypt) can't persist and wipe config/pins.

function isValidConfig(v) {
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.host === "string" &&
    v.host.trim().length > 0 &&
    v.port != null &&
    v.port !== "" &&
    Number.isFinite(Number(v.port))
  )
}

function isPinObject(v) {
  return !!v && typeof v === "object" && typeof v.id === "string" && v.id.length > 0
}

function isValidPinsArray(v) {
  return Array.isArray(v) && v.every(isPinObject)
}

module.exports = { isValidConfig, isPinObject, isValidPinsArray }
