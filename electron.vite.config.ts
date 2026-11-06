import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
      target: 'node22',
      sourcemap: false,
      minify: false
    }
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
      target: 'node22',
      sourcemap: false,
      minify: false
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      target: 'chrome130',
      sourcemap: false,
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  }
})