import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentIndicator from '../../src/components/AgentIndicator.vue'
import { type AgentActivity, api } from '../../src/shared/api'

beforeEach(() => {
  vi.spyOn(api, 'agentsActivity').mockResolvedValue([])
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('AgentIndicator', () => {
  it('renders the chip and keeps the popover closed by default', () => {
    const wrapper = mount(AgentIndicator)
    expect(wrapper.text()).toContain('AI agents')
    expect(wrapper.find('[data-test="agent-popover"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('opens the popover on click and shows the honest empty state', async () => {
    const wrapper = mount(AgentIndicator)
    await wrapper.find('[data-test="agent-trigger"]').trigger('click')
    const popover = wrapper.find('[data-test="agent-popover"]')
    expect(popover.exists()).toBe(true)
    expect(popover.text()).toContain('No agent activity yet — connect an agent over MCP.')
    wrapper.unmount()
  })

  it('closes the popover on a second click', async () => {
    const wrapper = mount(AgentIndicator)
    const trigger = wrapper.find('[data-test="agent-trigger"]')
    await trigger.trigger('click')
    await trigger.trigger('click')
    expect(wrapper.find('[data-test="agent-popover"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('closes on Escape while open', async () => {
    const wrapper = mount(AgentIndicator)
    await wrapper.find('[data-test="agent-trigger"]').trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-test="agent-popover"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('does not close on a non-Escape key while open', async () => {
    const wrapper = mount(AgentIndicator)
    await wrapper.find('[data-test="agent-trigger"]').trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(wrapper.find('[data-test="agent-popover"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('ignores Escape while closed', () => {
    const wrapper = mount(AgentIndicator)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(wrapper.find('[data-test="agent-popover"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('closes on a click outside the popover (backdrop)', async () => {
    const wrapper = mount(AgentIndicator)
    await wrapper.find('[data-test="agent-trigger"]').trigger('click')
    expect(wrapper.find('[data-test="agent-popover"]').exists()).toBe(true)
    await wrapper.find('[data-test="agent-backdrop"]').trigger('click')
    expect(wrapper.find('[data-test="agent-popover"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('does not close when clicking inside the popover', async () => {
    const wrapper = mount(AgentIndicator)
    await wrapper.find('[data-test="agent-trigger"]').trigger('click')
    await wrapper.find('[data-test="agent-popover"]').trigger('click')
    expect(wrapper.find('[data-test="agent-popover"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('has no backdrop/popover while closed', () => {
    const wrapper = mount(AgentIndicator)
    expect(wrapper.find('[data-test="agent-backdrop"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('AgentIndicator — live feed', () => {
  const nowSec = Math.floor(Date.now() / 1000)
  const feed: AgentActivity[] = [
    { who: 'claude-1', action: 'created', target: 'mf-web', ts: nowSec - 30 },
    { who: 'claude-1', action: 'exec', target: 'mf-web', ts: nowSec - 90 },
    { who: 'claude-2', action: 'suspended', target: 'mf-db', ts: nowSec - 3700 },
  ]

  it('polls api.agentsActivity(20) on mount and renders rows with a distinct-who badge', async () => {
    const activity = vi.spyOn(api, 'agentsActivity').mockResolvedValue(feed)
    const wrapper = mount(AgentIndicator)
    await flushPromises()
    expect(activity).toHaveBeenCalledWith(20)

    expect(wrapper.find('[data-test="agent-count"]').text()).toBe('2')

    await wrapper.find('[data-test="agent-trigger"]').trigger('click')
    const rows = wrapper.findAll('[data-test="agent-row"]')
    expect(rows).toHaveLength(3)
    expect(rows[0]?.text()).toContain('claude-1 · created · mf-web · just now')
    expect(rows[1]?.text()).toContain('claude-1 · exec · mf-web · 1m ago')
    expect(rows[2]?.text()).toContain('claude-2 · suspended · mf-db · 1h ago')
    wrapper.unmount()
  })

  it('re-polls every 5s and keeps the feed live', async () => {
    vi.useFakeTimers()
    const activity = vi.spyOn(api, 'agentsActivity').mockResolvedValue([])
    const wrapper = mount(AgentIndicator)
    await flushPromises()
    expect(activity).toHaveBeenCalledTimes(1)

    activity.mockResolvedValueOnce(feed)
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    expect(activity).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-test="agent-count"]').text()).toBe('2')
    wrapper.unmount()
  })

  it('clears the poll interval on unmount', async () => {
    vi.useFakeTimers()
    const activity = vi.spyOn(api, 'agentsActivity').mockResolvedValue([])
    const wrapper = mount(AgentIndicator)
    await flushPromises()
    wrapper.unmount()

    activity.mockClear()
    await vi.advanceTimersByTimeAsync(10000)
    expect(activity).not.toHaveBeenCalled()
  })

  it('keeps the honest empty state and no badge when the feed is empty', async () => {
    vi.spyOn(api, 'agentsActivity').mockResolvedValue([])
    const wrapper = mount(AgentIndicator)
    await flushPromises()
    expect(wrapper.find('[data-test="agent-count"]').exists()).toBe(false)

    await wrapper.find('[data-test="agent-trigger"]').trigger('click')
    const popover = wrapper.find('[data-test="agent-popover"]')
    expect(popover.text()).toContain('No agent activity yet — connect an agent over MCP.')
    expect(wrapper.findAll('[data-test="agent-row"]')).toHaveLength(0)
    wrapper.unmount()
  })
})
