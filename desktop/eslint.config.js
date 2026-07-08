import tsParser from '@typescript-eslint/parser'
import biomeConfig from 'eslint-config-biome'
import pluginVue from 'eslint-plugin-vue'

export default [
  ...pluginVue.configs['flat/recommended'],
  biomeConfig,
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tsParser,
      },
    },
    rules: {
      // False positive: ESLint cannot see template usage of script setup bindings
      'no-useless-assignment': 'off',
      // Toasts.vue is the task-mandated filename for the single-word "toast layer" component.
      'vue/multi-word-component-names': ['error', { ignores: ['Toasts'] }],
    },
  },
  {
    ignores: ['dist/', 'src-tauri/target/', 'node_modules/', 'coverage/'],
  },
]
