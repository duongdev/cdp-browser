export interface Size {
  w: number
  h: number
}

export interface Letterbox {
  scale: number
  dx: number
  dy: number
}

/**
 * The single source of letterbox truth: how a Screencast Frame is fitted into the
 * canvas. A frame rarely matches the canvas aspect ratio, so it is scaled to fit and
 * centered, leaving black bars on two sides. Both the draw path and Input Forwarding
 * hit-testing derive from this — keeping them drift-proof.
 */
export function letterbox(frame: Size, canvas: Size): Letterbox {
  const scale = Math.min(canvas.w / frame.w, canvas.h / frame.h)
  const dx = (canvas.w - frame.w * scale) / 2
  const dy = (canvas.h - frame.h * scale) / 2
  return { scale, dx, dy }
}

export interface ModifierKeys {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/** Encodes held modifier keys as the CDP bitmask: alt=1, ctrl=2, meta=4, shift=8. */
export function modifiers(e: ModifierKeys): number {
  let m = 0
  if (e.altKey) m |= 1
  if (e.ctrlKey) m |= 2
  if (e.metaKey) m |= 4
  if (e.shiftKey) m |= 8
  return m
}

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Maps a client (canvas-relative viewport) point to Remote Page pixels, undoing the
 * device pixel ratio and the letterbox offset. Uses the same `letterbox` as the draw
 * path, so a click always lands where the user sees it.
 */
export function toRemoteCoords(
  client: { x: number; y: number },
  rect: Rect,
  dpr: number,
  frame: Size,
): { x: number; y: number } {
  const canvas = { w: rect.width * dpr, h: rect.height * dpr }
  const { scale, dx, dy } = letterbox(frame, canvas)
  const px = (client.x - rect.left) * dpr
  const py = (client.y - rect.top) * dpr
  return {
    x: Math.round((px - dx) / scale),
    y: Math.round((py - dy) / scale),
  }
}
