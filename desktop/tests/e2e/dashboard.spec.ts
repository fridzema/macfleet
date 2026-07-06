import { expect, test } from '@playwright/test'

test('sidebar lists mocked VMs and selecting shows detail', async ({ page }) => {
  await page.route('**/vms', (route) =>
    route.fulfill({ json: [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }] }),
  )
  await page.route('**/vms/*/screenshot', (route) => route.fulfill({ json: { png_b64: 'QUJD' } }))
  await page.route('**/vms/*/logs**', (route) => route.fulfill({ json: { lines: 'ok' } }))

  await page.goto('/')
  const row = page.getByTestId('vm-row')
  // VMs are shown by their short (mf-stripped) name.
  await expect(row).toHaveText(/web/)
  await row.click()
  await expect(page.getByTestId('shot')).toBeVisible()
})
