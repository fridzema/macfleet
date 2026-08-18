import { onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useFleet } from '../stores/fleet'
import { useSettings } from '../stores/settings'
import { useUi } from '../stores/ui'

interface TrayAction {
  action: string
  vm?: string
}

const short = (n: string): string => (n.startsWith('mf-') ? n.slice(3) : n)

/** Handles the `tray-action` events Rust emits for menu items that surface the window
 * (Settings/Doctor/New/Suspend-all/Show). Lifecycle and connect actions execute in Rust and
 * never reach here. Mounted once at app scope (DefaultLayout), so it lives as long as the app. */
export function useTrayMenu(): void {
  // The router must be grabbed during setup (it is injected); the stores are resolved per
  // event instead, so mounting the layout never requires an active Pinia.
  const router = useRouter()

  async function dispatch(a: TrayAction): Promise<void> {
    switch (a.action) {
      case 'settings':
        await router.push('/settings')
        break
      case 'doctor':
        await router.push('/settings')
        void useSettings().runDoctor()
        break
      case 'new':
        void useFleet().create()
        break
      case 'show':
        if (a.vm) useUi().selectVm(a.vm)
        break
      case 'suspend-all': {
        // bulkSuspend, not a suspend() per VM: it caps concurrency and emits one summary
        // toast, which is what every other multi-VM path in the app does.
        const fleet = useFleet()
        const running = fleet.vms.filter((v) => v.state === 'running').map((v) => short(v.name))
        if (running.length) void fleet.bulkSuspend(running)
        break
      }
    }
  }

  // Dynamic import: `@tauri-apps/api/event` is absent under vitest/vite-dev outside Tauri.
  // The mock in the test intercepts this; in a plain browser the catch keeps it inert.
  let unlisten: (() => void) | null = null
  import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<TrayAction>('tray-action', (e) => {
        void dispatch(e.payload)
      }),
    )
    .then((un) => {
      unlisten = un
    })
    .catch(() => {})

  onUnmounted(() => unlisten?.())
}
