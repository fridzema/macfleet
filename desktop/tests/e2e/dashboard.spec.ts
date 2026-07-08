import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

test('sidebar lists mocked VMs and selecting shows detail', async ({ page }) => {
  await mockApi(page, {
    vms: [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }],
  })

  await page.goto('/')
  const row = page.getByTestId('vm-row')
  // VMs are shown by their short (mf-stripped) name.
  await expect(row).toHaveText(/web/)
  await row.click()
  await expect(page.getByTestId('shot')).toBeVisible()
})
