import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const stripIgnoredVueUsePureAnnotations = {
  name: 'strip-ignored-vueuse-pure-annotations',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    // @vueuse/core currently ships two misplaced annotations that Rolldown ignores and warns
    // about. Removing only those ineffective comments keeps third-party warnings actionable.
    if (!id.includes('/node_modules/@vueuse/core/dist/index.js')) return
    return code.replaceAll('/* #__PURE__ */', '')
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [stripIgnoredVueUsePureAnnotations, vue(), tailwindcss()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
})
