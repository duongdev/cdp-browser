// Diacritic + case fold for Vietnamese-aware substring matching. Mirrors the
// `fold` in core/history-store.js (the renderer can't import that CJS module).
// NFD strips tone/diacritic combining marks; đ/Đ don't decompose so they're
// replaced explicitly.
export function fold(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
}
