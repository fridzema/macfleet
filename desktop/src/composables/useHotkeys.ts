import { onMounted, onUnmounted } from 'vue'

/** Global ⌘K / Ctrl-K → opens the command palette (comp `onKey`, lines 520–522). Scoped to
 * just the open behavior — the palette owns its own Escape/arrow handling once open (Task 13). */
export function useHotkeys(onOpenPalette: () => void): void {
  function onKey(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      onOpenPalette()
    }
  }
  onMounted(() => window.addEventListener('keydown', onKey))
  onUnmounted(() => window.removeEventListener('keydown', onKey))
}
