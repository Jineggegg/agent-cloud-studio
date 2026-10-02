import { createRequire } from 'node:module'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

// The client shows the installed package version so it can be compared against the
// version the server process is actually running. Reading package.json here and
// injecting it keeps the frontend free of imports that reach outside src/.
const pkg = createRequire(import.meta.url)('./package.json')

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly. 
  // This allows the vite server to EXPOSE all interfaces when the host 
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser 
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  
  const proxyHost = getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001

  return {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    // Pre-bundle the Studio's lazily reached UI libraries up front; discovering them mid-session
    // re-optimizes deps and can load two copies of React ("Invalid hook call").
    optimizeDeps: {
      include: ['motion/react', 'sonner', '@number-flow/react']
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      proxy: {
        '/api': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/plugin-ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          // Function form on purpose: the object form also pulls each listed package's
          // dependencies into its group, which put react/jsx-runtime inside vendor-codemirror
          // and made every chunk (the entry included) statically import the editor and the
          // terminal. Only the packages named here are grouped; shared helpers such as
          // @babel/runtime are left to Rollup so no unrelated chunk depends on these groups.
          // The editor and terminal groups stay lazy because only the IDE routes import them.
          manualChunks(id) {
            // Each non-English language's namespaces travel together, so switching language is one
            // request (src/modules/i18n/config.ts loads them on demand; English stays in the entry).
            const locale = id.match(/\/src\/modules\/i18n\/locales\/([^/]+)\//)
            if (locale && locale[1] !== 'en') return `locale-${locale[1]}`
            if (!id.includes('/node_modules/')) return undefined
            // The server renderer is only used by lazily loaded export code; keep it out of vendor-react.
            if (/\/node_modules\/react-dom\/(server|cjs\/react-dom-server)/.test(id)) return undefined
            if (/\/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@remix-run\/router)\//.test(id)) {
              return 'vendor-react'
            }
            if (/\/node_modules\/(@codemirror|@lezer|@uiw|@replit\/codemirror-[^/]+|@marijn|style-mod|w3c-keyname|crelt)\//.test(id)) {
              return 'vendor-codemirror'
            }
            if (/\/node_modules\/@xterm\//.test(id)) return 'vendor-xterm'
            return undefined
          }
        }
      }
    }
  }
})
