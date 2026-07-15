import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  BaseDirectory: { Home: 'Home' },
}))

import { readTextFile } from '@tauri-apps/plugin-fs'
import { useEngineLog } from '../../src/composables/useEngineLog'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useEngineLog', () => {
  it('reads the log from the home-relative path', async () => {
    vi.mocked(readTextFile).mockResolvedValue('a\nb\nc')
    const { lines, load } = useEngineLog()
    await load()
    expect(vi.mocked(readTextFile).mock.calls[0][0]).toBe('.macfleet/engine.log')
    expect(lines.value).toEqual(['a', 'b', 'c'])
  })

  it('keeps only the last N lines', async () => {
    const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    vi.mocked(readTextFile).mockResolvedValue(many)
    const { lines, load } = useEngineLog(10)
    await load()
    expect(lines.value).toHaveLength(10)
    expect(lines.value.at(-1)).toBe('line 499')
  })

  it('drops trailing blank lines from the file', async () => {
    vi.mocked(readTextFile).mockResolvedValue('a\nb\n')
    const { lines, load } = useEngineLog()
    await load()
    expect(lines.value).toEqual(['a', 'b'])
  })

  it('reports a missing log rather than throwing', async () => {
    vi.mocked(readTextFile).mockRejectedValue(new Error('No such file'))
    const { lines, error, load } = useEngineLog()
    await load()
    // The app may never have run the sidecar; that is a state, not a crash.
    expect(error.value).toContain('No such file')
    expect(lines.value).toEqual([])
  })
})
