import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  // .tsx too: the components carry user-facing sentences, and this project has
  // shipped several that stated something the code does not do. Rendering one
  // to a string needs no DOM and no extra dependency.
  test: { environment: 'node', include: ['**/*.test.ts', '**/*.test.tsx'] },
  resolve: {
    // Mirrors tsconfig.json's "@/*": ["./*"] so tests can import route
    // handlers (which use "@/..." imports) the same way app code does.
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
})
