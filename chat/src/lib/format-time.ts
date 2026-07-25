/** Format an epoch-ms timestamp as a zero-padded 24-hour `HH:mm:ss` local time (PSN-99 B1). Used for
 *  the small muted time shown beside a message bubble. Invalid input → empty string. */
export function formatHms(ts: number): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ""
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
