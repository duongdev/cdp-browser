import { Cancel01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useEffect } from "react"

interface ImageLightboxProps {
  /** The image src to show full-screen, or null when closed. */
  src: string | null
  onClose: () => void
}

/** Full-screen dimmed overlay showing one image at natural size, capped to the viewport (t139).
 *  Click the backdrop or press Esc to close. Rendered inline (position:fixed escapes the flow);
 *  a null src renders nothing. Theme-aware via the shared token palette. */
export function ImageLightbox({ src, onClose }: ImageLightboxProps) {
  useEffect(() => {
    if (!src) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [src, onClose])

  if (!src) return null

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: standard lightbox backdrop-close.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes (the keydown listener above).
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <button
        aria-label="Close"
        className="absolute top-3 right-3 flex size-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        onClick={onClose}
        type="button"
      >
        <HugeiconsIcon className="size-5" icon={Cancel01Icon} />
      </button>
      {/* A click anywhere (backdrop or image) closes — the whole overlay is one dismiss target. */}
      <img alt="" className="max-h-full max-w-full rounded-md object-contain" src={src} />
    </div>
  )
}
