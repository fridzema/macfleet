import { describe, expect, it } from 'vitest'
import { defaultSnapshotLabel, sanitizeLabel } from '../../src/shared/snapshot'

describe('snapshot labels', () => {
  it('replaces hyphens and spaces with dots', () => {
    expect(sanitizeLabel('web-snap test')).toBe('web.snap.test')
  })
  it('strips leading non-alphanumerics and caps length', () => {
    expect(sanitizeLabel('--clean')).toBe('clean')
    expect(sanitizeLabel('x'.repeat(80)).length).toBe(64)
  })
  it('formats a hyphen-free timestamp', () => {
    expect(defaultSnapshotLabel(new Date(2026, 6, 9, 15, 23, 1))).toBe('20260709.152301')
  })
})
