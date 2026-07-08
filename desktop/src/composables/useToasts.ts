import { ref } from 'vue'

export interface Toast {
  id: number
  msg: string
  icon: string
}

/** Schedules an auto-dismiss. Defaults to real `setTimeout`; tests inject their own so
 * dismissal can be driven synchronously instead of waiting on real time. */
export type Scheduler = (run: () => void, ms: number) => void

const DISMISS_MS = 2600

// Module-scoped so every `useToasts()` call (fleet store, ui store, ToastStack.vue)
// shares the same list rather than each getting an isolated copy.
const toasts = ref<Toast[]>([])
let nextId = 0

// The default scheduler used when a caller (e.g. the fleet/ui stores, which construct
// `useToasts()` internally and can't pass one) doesn't supply its own. Overridable so
// unit tests can swap in a no-op and never leave a real 2600ms timer dangling.
let defaultScheduler: Scheduler = (run, ms) => setTimeout(run, ms)

/** Test seam: replace the scheduler the parameterless `useToasts()` uses. */
export function setToastScheduler(schedule: Scheduler): void {
  defaultScheduler = schedule
}

export function useToasts(schedule: Scheduler = defaultScheduler) {
  function add(msg: string, icon = '✓'): void {
    const id = ++nextId
    toasts.value = [...toasts.value, { id, msg, icon }]
    schedule(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    }, DISMISS_MS)
  }

  return { toasts, add }
}
