export const API_BASE = 'http://127.0.0.1:8765'

export interface Vm {
  name: string
  state: string
  source: string
  healthy: boolean
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init)
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}`)
  return (await res.json()) as T
}

function postJson(path: string, payload: unknown): Promise<unknown> {
  return j(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export const api = {
  listVms: () => j<Vm[]>('/vms'),
  up: (n: string) => j(`/vms/${n}/up`, { method: 'POST' }),
  down: (n: string) => j(`/vms/${n}/down`, { method: 'POST' }),
  nuke: (n: string) => j(`/vms/${n}/nuke`, { method: 'POST' }),
  status: (n: string) => j<{ healthy: boolean }>(`/vms/${n}/status`),
  screenshot: (n: string) => j<{ png_b64: string }>(`/vms/${n}/screenshot`, { method: 'POST' }),
  click: (n: string, x: number, y: number) => postJson(`/vms/${n}/click`, { x, y }),
  typeText: (n: string, text: string) => postJson(`/vms/${n}/type`, { text }),
  key: (n: string, combo: string) => postJson(`/vms/${n}/key`, { combo }),
  logs: (n: string, lines = 100) => j<{ lines: string }>(`/vms/${n}/logs?lines=${lines}`),
}
