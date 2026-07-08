import { useDark, useToggle } from '@vueuse/core'

export function useDarkMode() {
  const isDark = useDark({
    selector: 'html',
    attribute: 'data-theme',
    valueDark: 'dark',
    valueLight: 'light',
    initialValue: 'dark',
    disableTransition: false,
  })
  const toggleDark = useToggle(isDark)
  return { isDark, toggleDark }
}
