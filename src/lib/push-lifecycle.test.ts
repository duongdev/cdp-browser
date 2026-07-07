import { describe, expect, it } from "vitest"
import { planBootPush, planForegroundRevalidate, planPostReconcile } from "./push-lifecycle"

describe("planBootPush", () => {
  it("reconciles when a live subscription exists (adopt server deviceId by endpoint)", () => {
    expect(planBootPush({ hasSub: true, knownIntent: "on" })).toBe("reconcile")
    expect(planBootPush({ hasSub: true, knownIntent: "off" })).toBe("reconcile")
    expect(planBootPush({ hasSub: true, knownIntent: "unknown" })).toBe("reconcile")
  })

  it("re-subscribes when no sub but a known device wants push (revocation recovery)", () => {
    expect(planBootPush({ hasSub: false, knownIntent: "on" })).toBe("resubscribe")
  })

  it("does nothing when no sub and intent is off or unknown (fresh wipe stays OFF)", () => {
    expect(planBootPush({ hasSub: false, knownIntent: "off" })).toBe("noop")
    expect(planBootPush({ hasSub: false, knownIntent: "unknown" })).toBe("noop")
  })
})

describe("planPostReconcile", () => {
  it("keeps the subscription when the server flag says push is on", () => {
    expect(planPostReconcile({ serverWebPush: true })).toBe("keep")
  })

  it("unsubscribes when the server flag says push was turned off", () => {
    expect(planPostReconcile({ serverWebPush: false })).toBe("unsubscribe")
  })
})

describe("planForegroundRevalidate", () => {
  it("revalidates only when the once-per-foreground gate fired and intent is on", () => {
    expect(planForegroundRevalidate({ gateFired: true, intentOn: true })).toBe(true)
  })

  it("does not revalidate when the gate did not fire", () => {
    expect(planForegroundRevalidate({ gateFired: false, intentOn: true })).toBe(false)
  })

  it("does not revalidate when push intent is off", () => {
    expect(planForegroundRevalidate({ gateFired: true, intentOn: false })).toBe(false)
  })
})
