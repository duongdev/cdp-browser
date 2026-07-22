// Clipboard/file image picking for the composer (t123). Pure: given a paste event's items (or a
// file-input FileList-of-items), return the first image File, else null — so a text paste falls
// through to the textarea untouched. The effectful base64/dimension reads live in teams-client.ts.

/** The slice of a `DataTransferItem` this reads: its MIME `type` and `getAsFile()`. */
interface ImageItemLike {
  type: string
  getAsFile(): File | null
}

/** First `image/*` File from a clipboard `DataTransferItemList` (or an array of such items), or null
 *  when there is none — an item with no backing File (getAsFile → null) is skipped, not fatal. */
export function pickImageFile(items: ArrayLike<ImageItemLike> | null | undefined): File | null {
  if (!items) return null
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it?.type?.startsWith("image/")) {
      const file = it.getAsFile()
      if (file) return file
    }
  }
  return null
}
