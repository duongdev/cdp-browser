// Pure planners for the web-build push subscription lifecycle (t099, C1).
// The effectful subscribe/unsubscribe/reconcile glue lives in `push-subscribe.ts`
// and `app.tsx`; these functions only encode the decision so it can be unit-tested.
// See docs/tasks/done/099-*.md and ADR-0014 (endpoint-reconciled per-device identity).

// What the durable server-side `webPush_<deviceId>` flag says the user wants, or
// "unknown" when we can't read it yet (fresh localStorage — no deviceId to key by).
export type PushIntent = "on" | "off" | "unknown"

// Boot decision. A live subscription is always reconciled first (adopt the server's
// endpoint-bound deviceId, then decide keep/drop via planPostReconcile). With no live
// subscription we only re-subscribe when a known device declared intent — a fresh
// wipe (unknown intent) stays OFF so we never resurrect push the user turned off.
export function planBootPush(input: {
  hasSub: boolean
  knownIntent: PushIntent
}): "reconcile" | "resubscribe" | "noop" {
  if (input.hasSub) return "reconcile"
  return input.knownIntent === "on" ? "resubscribe" : "noop"
}

// Post-reconcile decision. Once the endpoint reconcile has recovered the real
// deviceId, the durable server flag is the source of truth for whether push stays on.
export function planPostReconcile(input: { serverWebPush: boolean }): "keep" | "unsubscribe" {
  return input.serverWebPush ? "keep" : "unsubscribe"
}

// Foreground re-validate decision — the once-per-foreground gate must have fired and
// push intent must be on. Kept here so the wired behavior (not just the gate) is tested.
export function planForegroundRevalidate(input: {
  gateFired: boolean
  intentOn: boolean
}): boolean {
  return input.gateFired && input.intentOn
}
