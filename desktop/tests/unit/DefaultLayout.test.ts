import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import DefaultLayout from '../../src/layouts/DefaultLayout.vue'

const stubs = {
  AppHeader: { template: '<header data-testid="app-header" />' },
  CommandPalette: { template: '<div data-testid="command-palette" />' },
  ToastStack: { template: '<div data-testid="toasts" />' },
  RouterView: defineComponent({
    setup(_, { slots }) {
      const StubComponent = defineComponent({
        render: () => h('div', { 'data-testid': 'route-component' }),
      })
      return () =>
        h('div', { 'data-testid': 'router-view' }, slots.default?.({ Component: StubComponent }))
    },
  }),
}

describe('DefaultLayout', () => {
  it('renders the app header', () => {
    const wrapper = mount(DefaultLayout, { global: { stubs } })
    expect(wrapper.find('[data-testid="app-header"]').exists()).toBe(true)
  })

  it('renders router view', () => {
    const wrapper = mount(DefaultLayout, { global: { stubs } })
    expect(wrapper.find('[data-testid="router-view"]').exists()).toBe(true)
  })

  it('mounts the command palette at the app root', () => {
    const wrapper = mount(DefaultLayout, { global: { stubs } })
    expect(wrapper.find('[data-testid="command-palette"]').exists()).toBe(true)
  })

  it('mounts the toast layer at the app root', () => {
    const wrapper = mount(DefaultLayout, { global: { stubs } })
    expect(wrapper.find('[data-testid="toasts"]').exists()).toBe(true)
  })
})
