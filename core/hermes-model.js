// Applies the panel's model choice to the Hermes session (t179).
//
// The panel stores its pick on chat-server (`PATCH /sessions/:id {model}`) and the selector
// renders that value. On the Hermes path nothing ever forwarded it, so the label and the
// model that actually answered were unrelated: the picker read `glm/glm-5.1` while the turn
// ran on `hermes-default`. A wrong label is worse than a missing one — it is trusted.
//
// Why a LOCK and not a per-request `model` field. Measured against the live gateway:
//
//   POST /api/sessions/{id}/model {glm/glm-5.1}   -> 200, lock=confirmed
//   next turn                                      -> runs glm/glm-5.1        (lock honoured)
//   turn with body {model: glm/glm-4.7}            -> still runs glm/glm-5.1  (lock wins)
//
// Hermes precedence is lock > session override > session row > per-request. So once any lock
// exists on a session, a per-request field is silently ignored — it would have reintroduced
// the same lying-label bug one layer down. History survives the switch (verified: the session
// still recalled a word from before the lock).
//
// Tested by hermes-model.test.ts.

/**
 * Read the panel's curated model list from chat-server: every offered id, plus the one marked
 * default.
 *
 * The default is env-driven (`LLM_MODEL` on the deployment, exposed through /models), which is
 * what Dustin asked to be the single source of truth: change it on the deployment and every
 * consumer follows without a second place to edit.
 *
 * The id LIST matters separately — it is how a real user-visible switch is told apart from the
 * gateway's own internal model name, which the user never picked and would not recognise in a
 * thread.
 *
 * Never throws — no catalogue just means "no opinion", and the session keeps whatever it has.
 */
async function fetchModelCatalogue(bffUrl, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch
  try {
    const res = await doFetch(`${String(bffUrl).replace(/\/+$/, "")}/api/chat/assistant/models`, {
      headers: { "Content-Type": "application/json" },
    })
    if (!res.ok) return { ids: [], defaultId: "" }
    const body = await res.json()
    const models = Array.isArray(body?.models) ? body.models : []
    const ids = models.map((m) => m?.id).filter((id) => typeof id === "string")
    const def = models.find((m) => m?.default)
    return { ids, defaultId: typeof def?.id === "string" ? def.id : "" }
  } catch {
    return { ids: [], defaultId: "" }
  }
}

/**
 * Read a session's stored model pick from chat-server. Empty string when the session has no
 * pick, which means "use the deployment default" — not "use whatever ran last".
 */
async function fetchSessionModel(bffUrl, sessionId, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch
  try {
    const res = await doFetch(
      `${String(bffUrl).replace(/\/+$/, "")}/api/chat/assistant/sessions/${encodeURIComponent(sessionId)}/messages`,
      { headers: { "Content-Type": "application/json" } },
    )
    if (!res.ok) return { model: "" }
    const body = await res.json()
    const model = body?.session?.model
    return { model: typeof model === "string" ? model : "" }
  } catch {
    return { model: "" }
  }
}

/**
 * Ensure the Hermes session runs `wanted`, locking it when it differs from what is already
 * locked. Returns what the caller needs to decide whether to write a marker row.
 *
 * `previous` is the proxy's in-process memory of this session's model, or null when it has
 * none — after a restart, that is every session. Rather than treat null as "nothing was
 * locked" (which would announce a switch on a thread where nothing changed), the gateway is
 * asked: it persists the lock, so it holds the authoritative previous value.
 *
 * `changed` means a lock was applied. `announce` means a human-visible SWITCH happened and
 * deserves a row in the thread. They differ on purpose: the first lock of a session is not a
 * switch, and an unlocked session reports the gateway's own virtual model name — a value the
 * user never picked and would not recognise. Only a move between two models the panel offers
 * counts as something to announce.
 */
async function applyModelLock({ client, sessionId, wanted, previous, catalogue, log }) {
  if (!wanted) return { changed: false, announce: false, model: previous || "" }

  let from = previous
  if (!from) {
    from = (await client.sessionModel?.(sessionId)) || ""
  }
  if (wanted === from) return { changed: false, announce: false, model: from }

  const known = Array.isArray(catalogue) && catalogue.includes(from)
  try {
    const ok = await client.lockModel(sessionId, wanted)
    if (!ok) {
      // A refused lock leaves the session on its old model. Reporting it as changed would put
      // a marker row in the thread for a switch that did not happen.
      log?.(`[hermes] model lock rejected ${sessionId}: ${from || "(default)"} -> ${wanted}`)
      return { changed: false, announce: false, model: from, failed: true }
    }
    log?.(`[hermes] model ${sessionId}: ${from || "(default)"} -> ${wanted}`)
    return { changed: true, announce: known, model: wanted, from: from || null }
  } catch (e) {
    log?.(`[hermes] model lock failed ${sessionId}: ${e?.message || e}`)
    return { changed: false, announce: false, model: from, failed: true }
  }
}

module.exports = { fetchModelCatalogue, fetchSessionModel, applyModelLock }
