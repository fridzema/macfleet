import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setToastScheduler, useToasts } from '../../src/composables/useToasts'

beforeEach(() => {
  // Module-level singleton — clear between tests.
  useToasts().toasts.value = []
})

describe('useToasts', () => {
  it('add() appends a toast with a default icon', () => {
    const { toasts, add } = useToasts(vi.fn())
    add('Snapshot saved')
    expect(toasts.value).toEqual([{ id: expect.any(Number), msg: 'Snapshot saved', icon: '✓' }])
  })

  it('add() accepts a custom icon', () => {
    const { toasts, add } = useToasts(vi.fn())
    add('Lease expired — web', '⏱')
    expect(toasts.value[0].icon).toBe('⏱')
  })

  it('schedules auto-dismiss ~2.6s out using the injected scheduler', () => {
    const schedule = vi.fn()
    const { add } = useToasts(schedule)
    add('hi')
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 2600)
  })

  it('auto-dismisses via the injected scheduler without real timers', () => {
    let run = () => {}
    const schedule = vi.fn((fn: () => void) => {
      run = fn
    })
    const { toasts, add } = useToasts(schedule)
    add('hi')
    expect(toasts.value).toHaveLength(1)
    run()
    expect(toasts.value).toHaveLength(0)
  })

  it('dismisses only the toast whose timer fired, not later ones', () => {
    const runs: (() => void)[] = []
    const schedule = vi.fn((fn: () => void) => {
      runs.push(fn)
    })
    const { toasts, add } = useToasts(schedule)
    add('first')
    add('second')
    expect(toasts.value).toHaveLength(2)
    runs[0]()
    expect(toasts.value.map((t) => t.msg)).toEqual(['second'])
  })

  it('shares state across separate useToasts() calls (module-level singleton)', () => {
    const a = useToasts(vi.fn())
    const b = useToasts(vi.fn())
    a.add('shared')
    expect(b.toasts.value).toHaveLength(1)
    expect(b.toasts.value[0].msg).toBe('shared')
  })
})

describe('setToastScheduler', () => {
  // Restore the real setTimeout scheduler so this override doesn't bleed into
  // whatever runs next in-module.
  afterEach(() => setToastScheduler((run, ms) => setTimeout(run, ms)))

  it('overrides the scheduler used by the parameterless useToasts()', () => {
    const schedule = vi.fn()
    setToastScheduler(schedule)
    const { add } = useToasts() // no explicit scheduler -> uses the injected default
    add('hi')
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 2600)
  })
})
