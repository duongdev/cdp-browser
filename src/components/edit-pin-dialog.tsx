import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

interface EditPinDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The pin being edited; null while the dialog is closed. */
  pin: Pin | null
  /** Current URL of the pin's linked tab, if it has one (drives "Use current"). */
  liveUrl?: string
  onSave: (id: string, title: string, url: string) => void
}

export function EditPinDialog({ open, onOpenChange, pin, liveUrl, onSave }: EditPinDialogProps) {
  const [title, setTitle] = useState("")
  const [url, setUrl] = useState("")
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open && pin) {
      setTitle(pin.title)
      setUrl(pin.url)
      setTimeout(() => titleRef.current?.select(), 50)
    }
  }, [open, pin])

  const handleSave = () => {
    if (!pin || !url.trim()) return
    onSave(pin.id, title.trim() || url.trim(), url.trim())
    onOpenChange(false)
  }

  // Offer to snap the saved URL to wherever the linked tab has navigated.
  const canUseCurrent = !!liveUrl && liveUrl !== url

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle>Edit Pin</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label htmlFor="pin-title">Title</Label>
            <Input
              id="pin-title"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave()
              }}
              ref={titleRef}
              value={title}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="pin-url">URL</Label>
              {canUseCurrent && (
                <button
                  className="text-[11px] text-primary hover:underline"
                  onClick={() => liveUrl && setUrl(liveUrl)}
                  type="button"
                >
                  Use current tab URL
                </button>
              )}
            </div>
            <Input
              id="pin-url"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave()
              }}
              value={url}
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button onClick={() => onOpenChange(false)} variant="ghost">
              Cancel
            </Button>
            <Button disabled={!url.trim()} onClick={handleSave}>
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
