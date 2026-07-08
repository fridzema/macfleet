import { useDark, useToggle } from '@vueuse/core'
import { describe, expect, it, vi } from 'vitest'
import { useDarkMode } from '../../src/composables/useDarkMode'

vi.mock('@vueuse/core', () => ({
  useDark: vi.fn(() => ({ value: false })),
  useToggle: vi.fn(() => vi.fn()),
}))

describe('useDarkMode', () => {
  it('returns isDark and toggleDark', () => {
    const result = useDarkMode()
    expect(result).toHaveProperty('isDark')
    expect(result).toHaveProperty('toggleDark')
  })

  it('calls useDark with data-theme attribute config on the html element, defaulting to dark', () => {
    useDarkMode()
    expect(useDark).toHaveBeenCalledWith({
      selector: 'html',
      attribute: 'data-theme',
      valueDark: 'dark',
      valueLight: 'light',
      initialValue: 'dark',
      disableTransition: false,
    })
  })

  it('passes isDark ref to useToggle', () => {
    const mockRef = { value: false }
    vi.mocked(useDark).mockReturnValue(mockRef as ReturnType<typeof useDark>)
    useDarkMode()
    expect(useToggle).toHaveBeenCalledWith(mockRef)
  })
})
