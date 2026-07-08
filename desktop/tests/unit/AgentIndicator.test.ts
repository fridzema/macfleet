import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AgentIndicator from '../../src/components/AgentIndicator.vue'

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
