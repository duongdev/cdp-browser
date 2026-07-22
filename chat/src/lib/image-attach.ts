// Clipboard/file picking for the composer (t145 image, t146 any file). Pure: given a paste event's
// items, return the first item backed by a File (image OR any other file), else null — so a text
// paste (string items, no backing File) falls through to the textarea untouched. The effectful
// base64/dimension reads live in teams-client.ts.

/** The slice of a `DataTransferItem` this reads: only `getAsFile()`. */
interface FileItemLike {
  getAsFile(): File | null
}

/** First File from a clipboard `DataTransferItemList` (or an array of such items), or null when
 *  none is backed by a File — a string item (plain/rich text paste) yields no File and is skipped,
 *  so the paste falls through to the textarea. Any MIME type is accepted (image or otherwise). */
export function pickFile(items: ArrayLike<FileItemLike> | null | undefined): File | null {
  if (!items) return null
  for (let i = 0; i < items.length; i++) {
    const file = items[i]?.getAsFile()
    if (file) return file
  }
  return null
}
