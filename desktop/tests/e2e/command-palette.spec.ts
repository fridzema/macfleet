import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

test('Ctrl/Cmd+K opens the command palette, and running a command executes it', async ({
  page,
}) => {
  await mockApi(page)
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  await page.keyboard.press('Control+k')
  await expect(page.getByTestId('palette-modal')).toBeVisible()

  // Filter down to the one unambiguous, state-independent command so this test doesn't
  // depend on fleet contents: "Toggle dark theme" (App group, always present).
  await page.getByTestId('palette-input').fill('theme')
  await page.getByTestId('palette-input').press('Enter')

  await expect(page.getByTestId('palette-modal')).toBeHidden()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})
