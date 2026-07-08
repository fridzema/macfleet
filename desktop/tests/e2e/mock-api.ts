import type { Page, Route } from '@playwright/test'

export interface MockVm {
  name: string
  state: string
  source: string
  healthy: boolean
}

export interface MockSnapshot {
  id: string
  vm: string
  label: string
  size: number
}

export interface MockApiState {
  vms: MockVm[]
  snapshots: MockSnapshot[]
}

/** `/vms/<name>/<action>` -> `<name>`. The engine accepts either the short or `mf-`
 * prefixed form in the URL (see `fullname()` in the Python engine) and the desktop UI
 * always sends the short form — normalize to the full form so it matches `MockVm.name`. */
function vmName(route: Route): string {
  const parts = new URL(route.request().url()).pathname.split('/')
  const name = parts[2] ?? ''
  return name.startsWith('mf-') ? name : `mf-${name}`
}

/**
 * Wires a small stateful fake of the engine's REST API (127.0.0.1:8765) so e2e specs can
 * drive real user journeys (create, snapshot, delete, exec, ...) against the mocked
 * network layer instead of a live macOS VM engine. Every route macfleet's UI actually
 * calls during these journeys is covered; anything unmocked is left to Playwright's
 * default (which errors loudly rather than hitting a real server).
 */
export async function mockApi(
  page: Page,
  initial: { vms?: MockVm[]; snapshots?: MockSnapshot[] } = {},
): Promise<MockApiState> {
  const state: MockApiState = { vms: initial.vms ?? [], snapshots: initial.snapshots ?? [] }

  await page.route('**/host', (route) =>
    route.fulfill({ json: { total_mem_gb: 32, cpu_count: 8, name: 'Mac' } }),
  )

  // AppHeader's AgentIndicator polls this on every page, so every journey needs it mocked.
  await page.route('**/agents/activity*', (route) =>
    route.fulfill({
      json: [{ who: 'claude-code', action: 'created', target: 'web', ts: Date.now() }],
    }),
  )

  await page.route('**/vms', async (route) => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: state.vms })
    const body = route.request().postDataJSON() as { name: string }
    state.vms.push({ name: `mf-${body.name}`, state: 'running', source: 'local', healthy: true })
    return route.fulfill({ json: { ok: true } })
  })

  await page.route('**/snapshots', (route) => route.fulfill({ json: state.snapshots }))

  await page.route('**/vms/*/nuke', (route) => {
    const name = vmName(route)
    state.vms = state.vms.filter((v) => v.name !== name)
    return route.fulfill({ json: { ok: true } })
  })

  await page.route('**/vms/*/snapshot', (route) => {
    const name = vmName(route)
    const { label } = route.request().postDataJSON() as { label: string }
    state.snapshots.push({ id: `${name}-${label}`, vm: name, label, size: 12 })
    return route.fulfill({ json: { snapshot_id: `${name}-${label}` } })
  })

  await page.route('**/vms/*/suspend', (route) => {
    const vm = state.vms.find((v) => v.name === vmName(route))
    if (vm) vm.state = 'stopped'
    return route.fulfill({ json: { ok: true } })
  })

  await page.route('**/vms/*/resume', (route) => {
    const vm = state.vms.find((v) => v.name === vmName(route))
    if (vm) {
      vm.state = 'running'
      vm.healthy = true
    }
    return route.fulfill({ json: { ok: true } })
  })

  await page.route('**/vms/*/screenshot', (route) => route.fulfill({ json: { png_b64: 'QUJD' } }))
  await page.route('**/vms/*/logs**', (route) =>
    route.fulfill({ json: { lines: 'boot ok\nserver up' } }),
  )
  await page.route('**/vms/*/resources', (route) =>
    route.fulfill({
      json: { cpu: 4, memory_mb: 8192, disk_gb: 50, display: '1920x1080', state: 'running' },
    }),
  )
  await page.route('**/vms/*/metrics', (route) =>
    route.fulfill({ json: { cpu_pct: 25.5, mem_used_mb: 8029, mem_total_mb: 8192 } }),
  )
  await page.route('**/vms/*/connection', (route) =>
    route.fulfill({
      json: {
        ip: '192.168.64.12',
        ssh: 'ssh admin@192.168.64.12',
        vnc: 'open vnc://192.168.64.12',
        guest_server: 'http://192.168.64.12:8000',
        exec: true,
      },
    }),
  )
  await page.route('**/vms/*/exec', (route) =>
    route.fulfill({ json: { stdout: 'hello\n', exit_code: 0 } }),
  )

  return state
}
