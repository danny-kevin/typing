import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

/**
 * The renderer's Content-Security-Policy is shipped in index.html and allows no
 * network origins at all. The dev server needs its own websocket and http origin
 * for hot reload, so only `electron-vite dev` widens `connect-src`; the packaged
 * build keeps the strict policy.
 */
const DEV_CONNECT_SRC = " ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*"

function devCspPlugin(): Plugin {
  return {
    name: 'typing-dev-csp',
    apply: 'serve',
    transformIndexHtml(html: string) {
      return html.replace("connect-src 'self' typing-asset:;", `connect-src 'self' typing-asset:${DEV_CONNECT_SRC};`)
    }
  }
}

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
    plugins: [devCspPlugin()],
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