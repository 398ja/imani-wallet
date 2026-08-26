import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `packages/` and `shared/` were copied in from imani-apps and keep their own
  // conventions; linting them under this app's rules would report thousands of
  // findings about code this change did not write. `shared/` is vanilla JS and
  // would not match the files glob today anyway — listed so that adding a JS
  // block later does not silently pull 500 KB of it in.
  // `android/` is Capacitor's generated native project. Its build output
  // contains a copy of the web bundle plus Capacitor's own `native-bridge.js`,
  // none of which this repo authors.
  globalIgnores(['dist', 'packages', 'shared', 'android']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
])
