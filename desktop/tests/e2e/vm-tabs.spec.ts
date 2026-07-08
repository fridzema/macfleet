import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

test.describe('selecting a VM renders each of the 5 tabs', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page, {
      vms: [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }],
    })
    await page.goto('/')
    await page.getByTestId('vm-row').click()
  })

  test('Screen tab shows the polled screenshot', async ({ page }) => {
    await expect(page.getByTestId('shot')).toBeVisible()
  })

  test('Terminal tab runs a command against the mocked exec endpoint', async ({ page }) => {
    await page.getByTestId('tab-terminal').click()
    await page.getByTestId('term-input').fill('echo hello')
    await page.getByTestId('run-btn').click()

    const entry = page.getByTestId('term-entry')
    await expect(entry).toContainText('echo hello')
    await expect(entry).toContainText('hello')
    await expect(entry.getByTestId('term-code')).toHaveText('exit 0')
  })

  test('Logs tab tails the mocked log lines', async ({ page }) => {
    await page.getByTestId('tab-logs').click()
    await expect(page.getByTestId('logscroll')).toContainText('server up')
  })

  test('Resources tab shows the mocked resource cards and live metrics', async ({ page }) => {
    await page.getByTestId('tab-resources').click()
    await expect(page.getByTestId('card-cpu')).toContainText('4')
    await expect(page.getByTestId('card-memory')).toContainText('8')
    await expect(page.getByTestId('card-disk')).toContainText('50')
    await expect(page.getByTestId('card-cpu')).toContainText('25.5% load')
  })

  test('Connect tab shows connection info, and Copy confirms', async ({ page, context }) => {
    // Copy now only flashes "✓ Copied" once navigator.clipboard.writeText actually
    // resolves. Chromium denies clipboard-write without an explicit grant; Firefox/
    // WebKit allow it in Playwright without one and don't support this permission
    // name, so ignore a grant failure there.
    await context.grantPermissions(['clipboard-write']).catch(() => {})
    await page.getByTestId('tab-connect').click()
    const item = page.getByTestId('connect-item').first()
    await expect(item).toContainText('192.168.64.12')

    await item.getByTestId('copy-btn').click()
    await expect(item.getByTestId('copy-btn')).toHaveText('✓ Copied')
  })
})
