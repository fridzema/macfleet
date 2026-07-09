// Snapshot labels become part of the id `mfsnap-<vm>-<label>`, split on the last hyphen,
// so a label must have no hyphen. The engine validator allows only [A-Za-z0-9._] with an
// alphanumeric first char; mirror that here for instant feedback (engine still validates).
const INVALID = /[^A-Za-z0-9._]/g

export function sanitizeLabel(raw: string): string {
  return raw
    .trim()
    .replace(INVALID, '.')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64)
}

export function defaultSnapshotLabel(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `.${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  )
}
