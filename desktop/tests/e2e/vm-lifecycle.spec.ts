import { expect, test } from '@playwright/test'
import { mockApi } from './mock-api'

test('creating a VM with advanced options (snapshot source, preset, TTL) adds it to the fleet list', async ({
  page,
}) => {
  await mockApi(page, {
    snapshots: [{ id: 'snap1', vm: 'mf-golden', label: 'clean-14', size: 20 }],
  })
  await page.goto('/')

  await page.getByTestId('up-name').fill('ci-clone')
  await page.getByTestId('create-advanced-toggle').click()
  await page.getByTestId('create-source').selectOption('snap1')
  await page.getByTestId('create-preset').selectOption('heavy')
  await page.getByTestId('create-ttl').check()
  await page.getByTestId('up-btn').click()

  await expect(page.getByTestId('vm-row')).toHaveText(/ci-clone/)
})

test('snapshotting a selected VM adds it to the sidebar snapshot list', async ({ page }) => {
  await mockApi(page, {
    vms: [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }],
  })
  await page.goto('/')

  await page.getByTestId('vm-row').click()
  await page.getByTestId('snapshot-btn').click()

  const snapRow = page.getByTestId('snap-row')
  await expect(snapRow).toBeVisible()
  await expect(snapRow).toContainText('web-snap')
})

test('two-step delete: arms a confirm, then Yes removes the VM from the fleet', async ({
  page,
}) => {
  await mockApi(page, {
    vms: [{ name: 'mf-web', state: 'running', source: 'local', healthy: true }],
  })
  await page.goto('/')

  await page.getByTestId('vm-row').click()
  await page.getByTestId('delete-btn').click()
  await expect(page.getByTestId('delete-yes')).toBeVisible()

  await page.getByTestId('delete-yes').click()
  await expect(page.getByTestId('vm-row')).toHaveCount(0)
})
