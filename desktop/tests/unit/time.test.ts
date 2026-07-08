import { describe, expect, it } from 'vitest'
import { relativeTime } from '../../src/shared/time'

const nowMs = 1_700_000_000_000
const nowSec = nowMs / 1000

describe('relativeTime', () => {
  it('returns "just now" for a timestamp seconds ago', () => {
    expect(relativeTime(nowSec - 30, nowMs)).toBe('just now')
  })

  it('returns "just now" right up to the 60s boundary', () => {
    expect(relativeTime(nowSec - 59, nowMs)).toBe('just now')
  })

  it('returns "just now" for a timestamp in the future', () => {
    expect(relativeTime(nowSec + 30, nowMs)).toBe('just now')
  })

  it('returns minutes ago once at least a minute has passed', () => {
    expect(relativeTime(nowSec - 60, nowMs)).toBe('1m ago')
    expect(relativeTime(nowSec - 125, nowMs)).toBe('2m ago')
    expect(relativeTime(nowSec - 3599, nowMs)).toBe('59m ago')
  })

  it('returns hours ago once at least an hour has passed', () => {
    expect(relativeTime(nowSec - 3600, nowMs)).toBe('1h ago')
    expect(relativeTime(nowSec - 7325, nowMs)).toBe('2h ago')
  })
})
