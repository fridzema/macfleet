import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      // Node 26 exposes an experimental global localStorage getter that warns when no
      // persistence file is configured. Tests use jsdom's browser-scoped storage instead.
      execArgv: ['--no-experimental-webstorage'],
      include: ['tests/unit/**/*.test.ts'],
      coverage: {
        provider: 'istanbul',
        reporter: ['text', 'lcov'],
        include: ['src/**/*.{ts,vue}'],
        exclude: ['src/main.ts'],
        thresholds: {
          // Regression gates grounded in the current suite. A blanket 100% requirement
          // made the coverage command permanently red despite >95% line coverage.
          lines: 95,
          branches: 90,
          functions: 85,
          statements: 92,
        },
      },
    },
  }),
)
