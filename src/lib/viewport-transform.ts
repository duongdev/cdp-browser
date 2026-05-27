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
 * Maps a client (canvas-relative viewport) point to Remote Page coordinates, undoing the
 * device pixel ratio and the letterbox offset. Uses the same `letterbox` as the draw path,
 * so a click always lands where the user sees it.
 *
 * The Screencast Frame is often *downscaled* from the remote layout viewport (the proxy
 * caps `Page.startScreencast` at the local canvas size, so a larger remote window arrives
 * smaller). CDP input wants DIP (CSS px) in the remote viewport's space, not frame-image
 * px — so when the frame's device size is known (`device`, from the frame metadata's
 * `deviceWidth`/`deviceHeight`) we scale image px → DIP. Without it we assume 1:1 (the
 * previous behavior, correct whenever the frame isn't downscaled). `offsetTop` is the
 * metadata's vertical DIP offset of the captured area (0 on desktop).
 */
export function toRemoteCoords(
  client: { x: number; y: number },
  rect: Rect,
  dpr: number,
  frame: Size,
  device?: Size,
  offsetTop = 0,
): { x: number; y: number } {
  const canvas = { w: rect.width * dpr, h: rect.height * dpr }
  const { scale, dx, dy } = letterbox(frame, canvas)
  const ix = ((client.x - rect.left) * dpr - dx) / scale
  const iy = ((client.y - rect.top) * dpr - dy) / scale
  const k = device ? device.w / frame.w : 1
  return {
    x: Math.round(ix * k),
    y: Math.round(iy * k - offsetTop),
  }
}
