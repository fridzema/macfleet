export const API_BASE = 'http://127.0.0.1:8765'

export interface Vm {
  name: string
  state: string
  source: string
  healthy: boolean
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

/** running = up + server healthy; booting = up but server not answering yet. */
export function vmStatus(vm: Pick<Vm, 'state' | 'healthy'>): VmStatus {
  if (vm.state === 'running') return vm.healthy ? 'running' : 'booting'
  return 'stopped'
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init)
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
  up: (n: string) => j(`/vms/${n}/up`, { method: 'POST' }),
  down: (n: string) => j(`/vms/${n}/down`, { method: 'POST' }),
  nuke: (n: string) => j(`/vms/${n}/nuke`, { method: 'POST' }),
  suspend: (n: string) => j(`/vms/${n}/suspend`, { method: 'POST' }),
  resume: (n: string) => j(`/vms/${n}/resume`, { method: 'POST' }),
  status: (n: string) => j<{ healthy: boolean }>(`/vms/${n}/status`),
  screenshot: (n: string) => j<{ png_b64: string }>(`/vms/${n}/screenshot`, { method: 'POST' }),
  click: (n: string, x: number, y: number) => postJson(`/vms/${n}/click`, { x, y }),
  typeText: (n: string, text: string) => postJson(`/vms/${n}/type`, { text }),
  key: (n: string, combo: string) => postJson(`/vms/${n}/key`, { combo }),
  logs: (n: string, lines = 100) => j<{ lines: string }>(`/vms/${n}/logs?lines=${lines}`),
  snapshot: (n: string, label: string) =>
    postJson<{ snapshot_id: string }>(`/vms/${n}/snapshot`, { label }),
  listSnapshots: () => j<Snapshot[]>('/snapshots'),
  deleteSnapshot: (id: string) => j(`/snapshots/${id}`, { method: 'DELETE' }),
  rename: (n: string, newName: string) => postJson(`/vms/${n}/rename`, { new: newName }),
  duplicate: (n: string, newName: string) => postJson(`/vms/${n}/duplicate`, { new: newName }),
  resources: (n: string) => j<Resources>(`/vms/${n}/resources`),
  setResources: (
    n: string,
    opts: { cpu?: number; memory?: number; disk_size?: number; display?: string },
  ) => putJson(`/vms/${n}/resources`, opts),
  connection: (n: string) => j<ConnectionInfo>(`/vms/${n}/connection`),
  exec: (n: string, command: string) => postJson<ExecResult>(`/vms/${n}/exec`, { command }),
  host: () => j<HostInfo>('/host'),
}
