import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

test('a rejected create shows the engine error and allows a successful retry', async ({ page }) => {
  await mockApi(page)
  let rejectCreate = true
  await page.route('**/vms', async (route) => {
    if (route.request().method() === 'POST' && rejectCreate) {
      await route.fulfill({ status: 409, json: { detail: 'Golden image is missing' } })
    } else {
      await route.fallback()
    }
  })
  await page.goto('/')
  await page.getByTestId('up-name').fill('retry-vm')
  await page.getByTestId('up-btn').click()
  await expect(page.getByText('Error: POST /vms -> 409: Golden image is missing')).toBeVisible()
  await expect(page.getByTestId('up-btn')).toBeEnabled()
  await expect(page.getByTestId('vm-row')).toHaveCount(0)
  rejectCreate = false
  await page.getByTestId('up-name').fill('retry-vm')
  await page.getByTestId('up-btn').click()
  await expect(page.getByTestId('vm-row')).toContainText('retry-vm')
})

test('cancelling delete keeps the VM and does not send a delete request', async ({ page }) => {
  await mockApi(page, {
    vms: [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }],
  })
  const deletes: string[] = []
  page.on('request', (request) => {
    if (request.url().endsWith('/nuke')) deletes.push(request.url())
  })
  await page.goto('/')
  await page.getByTestId('vm-row').click()
  await page.getByTestId('delete-btn').click()
  await page.getByTestId('delete-no').click()
  await expect(page.getByTestId('delete-yes')).toHaveCount(0)
  await expect(page.getByTestId('vm-row')).toHaveCount(1)
  expect(deletes).toEqual([])
})

test('shared folders default to read-only and can be changed and removed', async ({ page }) => {
  await mockApi(page, {
    vms: [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }],
  })
  let shares: { tag: string; host_path: string; read_only: boolean }[] = []
  await page.route('**/vms/*/shares', async (route) => {
    if (route.request().method() === 'PUT') shares = route.request().postDataJSON().shares
    await route.fulfill({ json: { shares } })
  })
  await page.goto('/')
  await page.getByTestId('vm-row').click()
  await page.getByTestId('tab-folders').click()
  await page.getByTestId('folders-add-path').fill('/tmp/release-fixture')
  await page.getByTestId('folders-add').click()
  const row = page.getByTestId('folders-share-row')
  await expect(row).toContainText('read-only')
  expect(shares).toEqual([
    { tag: 'release-fixture', host_path: '/tmp/release-fixture', read_only: true },
  ])
  await row.getByRole('button', { name: 'read-only' }).click()
  await expect(row).toContainText('read-write')
  expect(shares[0]?.read_only).toBe(false)
  await row.getByTestId('folders-remove').click()
  await expect(row).toHaveCount(0)
  expect(shares).toEqual([])
})
