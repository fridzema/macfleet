import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, API_BASE } from '../../src/shared/api'

afterEach(() => vi.restoreAllMocks())

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
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
})
