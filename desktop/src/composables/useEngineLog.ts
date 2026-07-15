import { type Ref, ref } from 'vue'

/** The engine sidecar's stdout, written by the Tauri host (src-tauri/src/lib.rs) to
 * ~/.macfleet/engine.log and rotated one generation per launch.
 *
 * Read straight off disk through the fs plugin rather than via the engine's API — on purpose.
 * This log exists to explain an engine that failed to start, so asking that engine for it
 * would fail exactly when it matters. */
const LOG_PATH = '.macfleet/engine.log'

export function useEngineLog(tail = 200): {
  lines: Ref<string[]>
  error: Ref<string | null>
  load: () => Promise<void>
  reveal: () => Promise<void>
} {
  const lines = ref<string[]>([])
  const error = ref<string | null>(null)

  async function load(): Promise<void> {
    error.value = null
    try {
      const { readTextFile, BaseDirectory } = await import('@tauri-apps/plugin-fs')
      const text = await readTextFile(LOG_PATH, { baseDir: BaseDirectory.Home })
      lines.value = text.replace(/\n+$/, '').split('\n').slice(-tail)
    } catch (e) {
      // No sidecar has run yet, or the file is unreadable. Both are states worth showing.
      error.value = String(e)
      lines.value = []
    }
  }

  async function reveal(): Promise<void> {
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener')
      const { homeDir, join } = await import('@tauri-apps/api/path')
      await revealItemInDir(await join(await homeDir(), LOG_PATH))
    } catch (e) {
      error.value = String(e)
    }
  }

  return { lines, error, load, reveal }
}
