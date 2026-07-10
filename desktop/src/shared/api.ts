import { invoke } from '@tauri-apps/api/core'

// Dev / e2e fallback base (non-Tauri). In the packaged app the real base + token come from
// the Rust host via get_api_config (per-run port + token); see apiConfig().
export const API_BASE = 'http://127.0.0.1:8765'

const enc = encodeURIComponent

interface ResolvedApi {
  base: string
  token: string | null
}

// Resolved once from the Rust host: the ephemeral port the engine sidecar actually runs on
// (so the app can't be fooled into talking to a stale server on a fixed port) plus the
// per-run token required on every API call. Fixed base + null token outside Tauri (vite dev,
// e2e), where the engine runs unauthenticated and the Playwright mock matches by path.
let configPromise: Promise<ResolvedApi> | null = null
function apiConfig(): Promise<ResolvedApi> {
  if (!configPromise) {
    const p = (async (): Promise<ResolvedApi> => {
      if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
        return { base: API_BASE, token: null }
      }
      const cfg = await invoke<{ port: number; token: string }>('get_api_config')
      return { base: `http://127.0.0.1:${cfg.port}`, token: cfg.token }
    })()
    configPromise = p
    // Don't cache a failed handshake — let the next request retry.
    p.catch(() => {
      if (configPromise === p) configPromise = null
    })
  }
  return configPromise
}

export interface Vm {
  name: string
  state: string
  source: string
  healthy: boolean
  cpu?: number | null
  memory_mb?: number | null
  disk_gb?: number | null
}

export type VmStatus = 'running' | 'booting' | 'stopped'

export interface Snapshot {
  id: string
  vm: string
  label: string
  size: number
}

export interface Resources {
  cpu: number
  memory_mb: number
  disk_gb: number
  display: string
  state: string
}

export interface Share {
  tag: string
  host_path: string
  read_only: boolean
}

export interface ConnectionInfo {
  ip: string
  ssh: string
  vnc: string
  guest_server: string
  exec: boolean
}

export interface ExecResult {
  stdout: string
  exit_code: number
}

export interface HostInfo {
  total_mem_gb: number
  cpu_count: number
  name: string
}

export interface AgentActivity {
  who: string
  action: string
  target: string
  ts: number
}

export interface Metrics {
  cpu_pct: number
  mem_used_mb: number
  mem_total_mb: number
}

/** running = up + server healthy; booting = up but server not answering yet. */
export function vmStatus(vm: Pick<Vm, 'state' | 'healthy'>): VmStatus {
  if (vm.state === 'running') return vm.healthy ? 'running' : 'booting'
  return 'stopped'
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const { base, token } = await apiConfig()
  if (token) {
    const headers = new Headers(init?.headers)
    headers.set('X-Macfleet-Token', token)
    init = { ...init, headers }
  }
  const res = await fetch(`${base}${path}`, init)
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}`)
  return (await res.json()) as T
}

function postJson<T = unknown>(path: string, payload: unknown): Promise<T> {
  return j<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

function putJson<T = unknown>(path: string, payload: unknown): Promise<T> {
  return j<T>(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export const api = {
  listVms: () => j<Vm[]>('/vms'),
  create: (
    name: string,
    opts: {
      from_snapshot?: string
      ttl?: number
      cpu?: number
      memory?: number
      disk?: number
    } = {},
  ) => postJson('/vms', { name, ...opts }),
  down: (n: string) => j(`/vms/${enc(n)}/down`, { method: 'POST' }),
  nuke: (n: string) => j(`/vms/${enc(n)}/nuke`, { method: 'POST' }),
  suspend: (n: string) => j(`/vms/${enc(n)}/suspend`, { method: 'POST' }),
  resume: (n: string) => j(`/vms/${enc(n)}/resume`, { method: 'POST' }),
  status: (n: string) => j<{ healthy: boolean }>(`/vms/${enc(n)}/status`),
  screenshot: (n: string) =>
    j<{ png_b64: string }>(`/vms/${enc(n)}/screenshot`, { method: 'POST' }),
  click: (n: string, x: number, y: number) => postJson(`/vms/${enc(n)}/click`, { x, y }),
  typeText: (n: string, text: string) => postJson(`/vms/${enc(n)}/type`, { text }),
  key: (n: string, combo: string) => postJson(`/vms/${enc(n)}/key`, { combo }),
  logs: (n: string, lines = 100) => j<{ lines: string }>(`/vms/${enc(n)}/logs?lines=${lines}`),
  snapshot: (n: string, label: string) =>
    postJson<{ snapshot_id: string }>(`/vms/${enc(n)}/snapshot`, { label }),
  restore: (n: string, snapshotId: string) =>
    postJson(`/vms/${enc(n)}/restore`, { snapshot_id: snapshotId }),
  getShares: (n: string) => j<{ shares: Share[] }>(`/vms/${enc(n)}/shares`),
  setShares: (n: string, shares: Share[]) => putJson(`/vms/${enc(n)}/shares`, { shares }),
  restartVm: (n: string) => j(`/vms/${enc(n)}/restart`, { method: 'POST' }),
  listSnapshots: () => j<Snapshot[]>('/snapshots'),
  deleteSnapshot: (id: string) => j(`/snapshots/${enc(id)}`, { method: 'DELETE' }),
  rename: (n: string, newName: string) => postJson(`/vms/${enc(n)}/rename`, { new: newName }),
  duplicate: (n: string, newName: string) => postJson(`/vms/${enc(n)}/duplicate`, { new: newName }),
  resources: (n: string) => j<Resources>(`/vms/${enc(n)}/resources`),
  setResources: (
    n: string,
    opts: { cpu?: number; memory?: number; disk_size?: number; display?: string },
  ) => putJson(`/vms/${enc(n)}/resources`, opts),
  connection: (n: string) => j<ConnectionInfo>(`/vms/${enc(n)}/connection`),
  exec: (n: string, command: string) => postJson<ExecResult>(`/vms/${enc(n)}/exec`, { command }),
  host: () => j<HostInfo>('/host'),
  agentsActivity: (limit?: number) =>
    j<AgentActivity[]>(`/agents/activity${limit !== undefined ? `?limit=${limit}` : ''}`),
  metrics: (n: string) => j<Metrics>(`/vms/${enc(n)}/metrics`),
}
