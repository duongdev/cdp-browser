import { describe, expect, it } from "vitest"
import { createHoverOverlayOwner } from "./hover-overlay-owner"

/** A fake clock so the delay policy is asserted without real timers. */
function fakeClock() {
  let now = 0
  let seq = 0
  const jobs = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq
      jobs.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (h: unknown) => {
      jobs.delete(h as number)
    },
    tick(ms: number) {
      now += ms
      for (const [id, job] of [...jobs]) {
        if (job.at <= now) {
          jobs.delete(id)
          job.fn()
        }
      }
    },
  }
}

const make = () => {
  const clock = fakeClock()
  const store = createHoverOverlayOwner({
    openDelay: 100,
    closeDelay: 50,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  return { store, clock }
}

describe("hover overlay owner", () => {
  it("waits the open delay before showing", () => {
    const { store, clock } = make()
    store.requestOpen("a")
    expect(store.owner()).toBeNull()
    clock.tick(99)
    expect(store.owner()).toBeNull()
    clock.tick(1)
    expect(store.owner()).toBe("a")
  })

  it("never opens when the pointer brushes past before the delay", () => {
    const { store, clock } = make()
    store.requestOpen("a")
    clock.tick(40)
    store.requestClose("a")
    clock.tick(500)
    expect(store.owner()).toBeNull()
  })

  it("keeps at most one owner across a fast travel over many rows", () => {
    const { store, clock } = make()
    store.requestOpen("a")
    clock.tick(100)
    for (const id of ["b", "c", "d"]) {
      store.requestOpen(id)
      expect(store.owner()).toBe(id) // instant swap, never two
    }
    clock.tick(500)
    expect(store.owner()).toBe("d")
  })

  it("closes after the grace delay, not instantly", () => {
    const { store, clock } = make()
    store.requestOpen("a")
    clock.tick(100)
    store.requestClose("a")
    expect(store.owner()).toBe("a")
    clock.tick(50)
    expect(store.owner()).toBeNull()
  })

  it("survives crossing the anchor→content gap", () => {
    const { store, clock } = make()
    store.requestOpen("a")
    clock.tick(100)
    store.requestClose("a")
    clock.tick(20)
    store.requestOpen("a")
    clock.tick(500)
    expect(store.owner()).toBe("a")
  })

  it("a locked owner ignores hover on other rows and its own leave", () => {
    const { store, clock } = make()
    store.requestOpen("a")
    clock.tick(100)
    store.setLocked("a", true)
    store.requestClose("a")
    store.requestOpen("b")
    clock.tick(500)
    expect(store.owner()).toBe("a")
  })

  it("locking opens the overlay even when nothing was hovered (keyboard react)", () => {
    const { store } = make()
    store.setLocked("a", true)
    expect(store.owner()).toBe("a")
  })

  it("unlocking falls back to the grace close", () => {
    const { store, clock } = make()
    store.setLocked("a", true)
    store.setLocked("a", false)
    expect(store.owner()).toBe("a")
    clock.tick(50)
    expect(store.owner()).toBeNull()
  })

  it("release only affects the owner, so a mounting row can't steal the bar", () => {
    const { store, clock } = make()
    store.requestOpen("a")
    clock.tick(100)
    store.release("b")
    expect(store.owner()).toBe("a")
    store.release("a")
    expect(store.owner()).toBeNull()
  })

  it("release beats a lock (blur / conversation switch with the picker open)", () => {
    const { store, clock } = make()
    store.setLocked("a", true)
    store.release("a")
    expect(store.owner()).toBeNull()
    store.requestOpen("b")
    clock.tick(100)
    expect(store.owner()).toBe("b") // the lock is gone, not stuck
  })

  it("closeUnlessLocked drops a hover overlay but spares an open picker", () => {
    const { store, clock } = make()
    store.requestOpen("a")
    clock.tick(100)
    store.closeUnlessLocked()
    expect(store.owner()).toBeNull()

    store.setLocked("b", true)
    store.closeUnlessLocked()
    expect(store.owner()).toBe("b")
  })

  it("closeUnlessLocked also cancels an armed open", () => {
    const { store, clock } = make()
    store.requestOpen("a")
    clock.tick(50)
    store.closeUnlessLocked()
    clock.tick(500)
    expect(store.owner()).toBeNull()
  })

  it("notifies subscribers on change only", () => {
    const { store, clock } = make()
    let calls = 0
    const off = store.subscribe(() => {
      calls++
    })
    store.requestOpen("a")
    clock.tick(100)
    expect(calls).toBe(1)
    store.requestOpen("a")
    clock.tick(100)
    expect(calls).toBe(1)
    off()
    store.release("a")
    expect(calls).toBe(1)
  })
})
