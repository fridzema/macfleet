import { expect, test } from '@playwright/test'

test.describe('App Navigation', () => {
  test('navigates to about page', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'About' }).click()
    await expect(page.getByText('A desktop application foundation built with')).toBeVisible()
  })
})
