import { onMounted, onUnmounted } from 'vue'

/** Global ⌘K / Ctrl-K → opens the command palette (comp `onKey`, lines 520–522), and
 * ⌘, / Ctrl-, → Settings (the macOS convention). Scoped to just those two openers — the
 * palette owns its own Escape/arrow handling once open (Task 13). */
export function useHotkeys(onOpenPalette: () => void, onOpenSettings?: () => void): void {
  function onKey(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey
    if (!mod) return
    const key = e.key.toLowerCase()
    if (key === 'k') {
      e.preventDefault()
      onOpenPalette()
    } else if (key === ',' && onOpenSettings) {
      e.preventDefault()
      onOpenSettings()
    }
  }
  onMounted(() => window.addEventListener('keydown', onKey))
  onUnmounted(() => window.removeEventListener('keydown', onKey))
}
