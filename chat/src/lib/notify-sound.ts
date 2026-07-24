// Pure mapping + thin player for notification sounds (PSN-98, Workstream C).
export type NotifySound = "none" | "chime-1" | "chime-2" | "chime-3"

/** Returns the URL for a sound file, or null for "none". Chat assets are served under the /chat/
 *  base (like sw.js + the manifest), so the path is /chat/sounds/... not /sounds/... */
export function soundFileFor(sound: NotifySound): string | null {
  if (sound === "none") return null
  return `/chat/sounds/${sound}.wav`
}

/** Fire-and-forget play. Silently ignores autoplay blocks or missing files. */
export function playNotifySound(sound: NotifySound): void {
  const file = soundFileFor(sound)
  if (!file) return
  const audio = new Audio(file)
  audio.play().catch(() => {})
}
