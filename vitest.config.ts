import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Tests cover the pure, electron-free logic (validation, redaction, agent
// templating, security URL checks, formatting). Native/electron-bound code
// (safeStorage, the full runner) stays in the Electron smoke scripts. The
// better-sqlite3 store is covered by smoke:store because the native module is
// rebuilt for the Electron ABI and cannot be loaded by Node/Vitest directly.
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
