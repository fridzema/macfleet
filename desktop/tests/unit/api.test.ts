import { afterEach, describe, expect, it, vi } from 'vitest'
import { API_BASE, api } from '../../src/shared/api'

afterEach(() => vi.restoreAllMocks())

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

describe('api', () => {
  it('listVms GETs /vms', async () => {
    const f = mockFetch(200, [{ name: 'mf-a', state: 'running', source: 'local', healthy: true }])
    const vms = await api.listVms()
    expect(f).toHaveBeenCalledWith(`${API_BASE}/vms`, undefined)
    expect(vms[0].name).toBe('mf-a')
  })

  it('click POSTs JSON coords', async () => {
    const f = mockFetch(200, { ok: true })
    await api.click('web', 5, 9)
    const [url, init] = f.mock.calls[0]
    expect(url).toBe(`${API_BASE}/vms/web/click`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ x: 5, y: 9 })
  })

  it('throws on non-ok', async () => {
    mockFetch(409, { detail: 'disabled' })
    await expect(api.screenshot('web')).rejects.toThrow('409')
  })

  it('create POSTs name + opts to /vms', async () => {
    const f = mockFetch(200, { ok: true })
    await api.create('mf-a', { from_snapshot: 'snap1', ttl: 60, cpu: 2, memory: 4096, disk: 40 })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe(`${API_BASE}/vms`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      name: 'mf-a',
      from_snapshot: 'snap1',
      ttl: 60,
      cpu: 2,
      memory: 4096,
      disk: 40,
    })
  })

  it('suspend POSTs /vms/{n}/suspend', async () => {
    const f = mockFetch(200, { ok: true })
    const res = await api.suspend('mf-a')
    expect(f).toHaveBeenCalledWith(`${API_BASE}/vms/mf-a/suspend`, { method: 'POST' })
    expect(res).toEqual({ ok: true })
  })

  it('resume POSTs /vms/{n}/resume', async () => {
    const f = mockFetch(200, { ok: true })
    await api.resume('mf-a')
    expect(f).toHaveBeenCalledWith(`${API_BASE}/vms/mf-a/resume`, { method: 'POST' })
  })

  it('snapshot POSTs label and returns snapshot_id', async () => {
    const f = mockFetch(200, { snapshot_id: 'mf-a-golden' })
    const res = await api.snapshot('mf-a', 'golden')
    const [url, init] = f.mock.calls[0]
    expect(url).toBe(`${API_BASE}/vms/mf-a/snapshot`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ label: 'golden' })
    expect(res).toEqual({ snapshot_id: 'mf-a-golden' })
  })

  it('listSnapshots GETs /snapshots', async () => {
    const f = mockFetch(200, [{ id: 'mf-a-golden', vm: 'mf-a', label: 'golden', size: 10.5 }])
    const res = await api.listSnapshots()
    expect(f).toHaveBeenCalledWith(`${API_BASE}/snapshots`, undefined)
    expect(res[0].id).toBe('mf-a-golden')
    expect(res[0].size).toBe(10.5)
  })

  it('deleteSnapshot DELETEs /snapshots/{id}', async () => {
    const f = mockFetch(200, { ok: true })
    await api.deleteSnapshot('mf-a-golden')
    expect(f).toHaveBeenCalledWith(`${API_BASE}/snapshots/mf-a-golden`, { method: 'DELETE' })
  })

  it('rename POSTs { new } to /vms/{n}/rename', async () => {
    const f = mockFetch(200, { ok: true })
    await api.rename('mf-a', 'mf-b')
    const [url, init] = f.mock.calls[0]
    expect(url).toBe(`${API_BASE}/vms/mf-a/rename`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ new: 'mf-b' })
  })

  it('duplicate POSTs { new } to /vms/{n}/duplicate', async () => {
    const f = mockFetch(200, { ok: true })
    await api.duplicate('mf-a', 'mf-a-copy')
    const [url, init] = f.mock.calls[0]
    expect(url).toBe(`${API_BASE}/vms/mf-a/duplicate`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ new: 'mf-a-copy' })
  })

  it('resources GETs /vms/{n}/resources', async () => {
    const f = mockFetch(200, {
      cpu: 2,
      memory_mb: 4096,
      disk_gb: 40,
      display: '1024x768',
      state: 'stopped',
    })
    const res = await api.resources('mf-a')
    expect(f).toHaveBeenCalledWith(`${API_BASE}/vms/mf-a/resources`, undefined)
    expect(res.cpu).toBe(2)
  })

  it('setResources PUTs body to /vms/{n}/resources', async () => {
    const f = mockFetch(200, { ok: true })
    await api.setResources('mf-a', { cpu: 4, memory: 8192 })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe(`${API_BASE}/vms/mf-a/resources`)
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toEqual({ cpu: 4, memory: 8192 })
  })

  it('connection GETs /vms/{n}/connection', async () => {
    const f = mockFetch(200, {
      ip: '10.0.0.5',
      ssh: 'ssh admin@10.0.0.5',
      vnc: 'open vnc://admin@10.0.0.5',
      guest_server: 'http://10.0.0.5:9000',
      exec: true,
    })
    const res = await api.connection('mf-a')
    expect(f).toHaveBeenCalledWith(`${API_BASE}/vms/mf-a/connection`, undefined)
    expect(res.ip).toBe('10.0.0.5')
  })

  it('exec POSTs command and returns stdout/exit_code', async () => {
    const f = mockFetch(200, { stdout: 'hi\n', exit_code: 0 })
    const res = await api.exec('mf-a', 'echo hi')
    const [url, init] = f.mock.calls[0]
    expect(url).toBe(`${API_BASE}/vms/mf-a/exec`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ command: 'echo hi' })
    expect(res).toEqual({ stdout: 'hi\n', exit_code: 0 })
  })

  it('host GETs /host', async () => {
    const f = mockFetch(200, { total_mem_gb: 32, cpu_count: 8, name: 'MacBook' })
    const res = await api.host()
    expect(f).toHaveBeenCalledWith(`${API_BASE}/host`, undefined)
    expect(res).toEqual({ total_mem_gb: 32, cpu_count: 8, name: 'MacBook' })
  })
})
