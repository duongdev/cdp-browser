import { type RefObject, type TouchEvent, useCallback, useRef, useState } from "react"

// Pull-to-refresh for the phone shell's scroll containers (UX). The native browser
// pull-to-refresh is gone in a standalone PWA (and we kill rubber-band with
// `overscroll-behavior: none`), so this re-adds the expected triage gesture: at the top of a
// scroller, dragging down past a threshold and releasing runs `onRefresh`. Pure state +
// a resistance curve; the caller spreads `handlers` on the scroll element, attaches `ref`,
// and renders an indicator from `{ pull, refreshing }`. No preventDefault needed — the
// content can't natively scroll up at the top (body is overflow-hidden), so we just
// translate it. Reduced-motion users still get the function; only the spinner stops spinning.
const THRESHOLD = 64
const MAX_PULL = 90
const RESISTANCE = 0.5

interface PullToRefresh {
  ref: RefObject<HTMLDivElement | null>
  pull: number
  refreshing: boolean
  armed: boolean
  handlers: {
    onTouchStart: (e: TouchEvent) => void
    onTouchMove: (e: TouchEvent) => void
    onTouchEnd: () => void
  }
}

export function usePullToRefresh(onRefresh: () => void | Promise<void>): PullToRefresh {
  const ref = useRef<HTMLDivElement>(null)
  const startY = useRef<number | null>(null)
  const refreshingRef = useRef(false)
  // Live pull distance held in a ref so the touch handlers stay referentially stable (pull
  // changes on every touchmove; reading it from state would churn their useCallback identity).
  const pullRef = useRef(0)
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const setPullBoth = useCallback((v: number) => {
    pullRef.current = v
    setPull(v)
  }, [])

  const onTouchStart = useCallback((e: TouchEvent) => {
    // Only arm when already scrolled to the very top — otherwise it's a normal scroll.
    startY.current =
      !refreshingRef.current && (ref.current?.scrollTop ?? 1) <= 0 ? e.touches[0].clientY : null
  }, [])

  const onTouchMove = useCallback(
    (e: TouchEvent) => {
      if (startY.current === null) return
      const dy = e.touches[0].clientY - startY.current
      setPullBoth(dy <= 0 ? 0 : Math.min(MAX_PULL, dy * RESISTANCE))
    },
    [setPullBoth],
  )

  const onTouchEnd = useCallback(() => {
    if (startY.current === null) return
    startY.current = null
    if (pullRef.current < THRESHOLD) {
      setPullBoth(0)
      return
    }
    refreshingRef.current = true
    setRefreshing(true)
    setPullBoth(THRESHOLD)
    Promise.resolve(onRefresh()).finally(() => {
      refreshingRef.current = false
      setRefreshing(false)
      setPullBoth(0)
    })
  }, [onRefresh, setPullBoth])

  return {
    ref,
    pull,
    refreshing,
    armed: pull >= THRESHOLD,
    handlers: { onTouchStart, onTouchMove, onTouchEnd },
  }
}
