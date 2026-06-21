import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Tests cover the pure, electron-free logic (validation, redaction, agent
// templating, security URL checks, formatting). Native/electron-bound code
// (better-sqlite3 store, safeStorage, the full runner) stays in the Electron
// smoke scripts, since better-sqlite3 is built for the Electron ABI.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  }
})
