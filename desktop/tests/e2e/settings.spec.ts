import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

test('user changes the default VM size and it sticks', async ({ page }) => {
  await mockApi(page, {
    vms: [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }],
  })
  await page.goto('/')
  await page.getByTestId('settings-button').click()
  await expect(page.getByTestId('settings-page')).toBeVisible()

  await expect(page.getByTestId('preset-standard')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('preset-heavy').click()
  await expect(page.getByTestId('preset-heavy')).toHaveAttribute('aria-checked', 'true')

  // Survives a reload because the engine, not the app, owns it.
  await page.reload()
  await expect(page.getByTestId('preset-heavy')).toHaveAttribute('aria-checked', 'true')
})

test('doctor renders the engine checks with their status', async ({ page }) => {
  await mockApi(page)
  await page.goto('/settings')
  await expect(page.getByTestId('check-arch')).toContainText('arm64')
  const warm = page.getByTestId('check-golden_warm')
  await expect(warm).toContainText("state is 'stopped'")
  await expect(warm).toContainText('macfleet warm')
})

test('back returns to the fleet', async ({ page }) => {
  await mockApi(page, {
    vms: [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }],
  })
  await page.goto('/settings')
  await page.getByTestId('settings-back').click()
  await expect(page.getByTestId('settings-page')).toHaveCount(0)
  await expect(page).toHaveURL(/\/$/)
})

test('the brand returns to the fleet', async ({ page }) => {
  await mockApi(page, {
    vms: [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }],
  })
  await page.goto('/settings')
  await page.getByTestId('brand-home').click()
  await expect(page.getByTestId('settings-page')).toHaveCount(0)
  await expect(page).toHaveURL(/\/$/)
})
