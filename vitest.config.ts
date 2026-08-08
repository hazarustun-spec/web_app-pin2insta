import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: { environment: 'node', include: ['**/*.test.ts'] },
  resolve: {
    // Mirrors tsconfig.json's "@/*": ["./*"] so tests can import route
    // handlers (which use "@/..." imports) the same way app code does.
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
})
