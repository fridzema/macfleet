import { expect, it, vi } from 'vitest'

// Own file: `apiConfig()` memoizes its resolution for the module's lifetime, and vitest
// isolates module state per test file — so the env must be stubbed before the import that
// triggers it, without leaking a stubbed base into the rest of the api suite.
vi.stubEnv('VITE_MACFLEET_TOKEN', 'dev-token')
vi.stubEnv('VITE_MACFLEET_API_BASE', 'http://127.0.0.1:9999')

it('sends VITE_MACFLEET_TOKEN outside Tauri so browser-only dev can reach a real engine', async () => {
  // `macfleet serve` always requires a token and there is no Tauri host here to supply one.
  const { api } = await import('../../src/shared/api')
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
  await api.listVms()
  const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
  expect(url).toBe('http://127.0.0.1:9999/vms')
  expect(new Headers(init.headers).get('X-Macfleet-Token')).toBe('dev-token')
})
