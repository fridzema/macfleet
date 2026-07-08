import { expect, test } from '@playwright/test'

test.describe('App Navigation', () => {
  // The redesigned shell (Task 15) is a single-page fleet dashboard with no in-app nav
  // link to /about — it's reached only by direct URL. This just confirms the route
  // still resolves and renders instead of exercising a nav link that no longer exists.
  test('renders the about route directly', async ({ page }) => {
    await page.goto('/about')
    await expect(page.getByText('A desktop client for macfleet')).toBeVisible()
  })
})
