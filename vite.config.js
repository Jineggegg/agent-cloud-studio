import { createRequire } from 'node:module'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

// The client shows the installed package version so it can be compared against the
// version the server process is actually running. Reading package.json here and
// injecting it keeps the frontend free of imports that reach outside src/.
const pkg = createRequire(import.meta.url)('./package.json')

// Marks the stylesheet links this plugin rewrites; LaunchSplashRelease (src/shared/ui/LaunchScreen.tsx)
// looks them up to keep the launch screen up until the styles are applied.
const ENTRY_STYLE_ATTRIBUTE = 'data-acs-entry-style'

// Vite injects the entry stylesheet (~240 KB) as a render-blocking <link rel="stylesheet">, which held
// back even the inline launch screen in index.html until the whole file had downloaded. Rewritten as a
// preload that turns itself into a stylesheet on load, the splash paints at once; no screen is revealed
// before the styles apply because LaunchSplashRelease waits for them. <noscript> keeps a plain link for
// the (theoretical) script-less visit. Build only: the dev server injects styles from JavaScript.
function nonBlockingEntryStylesheet() {
  return {
    name: 'acs-non-blocking-entry-stylesheet',
    apply: 'build',
    transformIndexHtml: {
      // After Vite has injected its asset tags.
      order: 'post',
      handler(html) {
        // Only same-origin bundle styles: the Google Fonts link already loads without blocking.
        const bundleStylesheet = /<link rel="stylesheet"( crossorigin)? href="(\/(?!\/)[^"]+\.css)">/g
        let rewritten = 0
        const result = html.replace(bundleStylesheet, (_tag, crossorigin = '', href) => {
          rewritten += 1
          return `<link rel="preload" as="style"${crossorigin} href="${href}" ${ENTRY_STYLE_ATTRIBUTE} onload="this.onload=null;this.rel='stylesheet'">`
            + `<noscript><link rel="stylesheet"${crossorigin} href="${href}"></noscript>`
        })
        // A Vite upgrade that changes the tag's shape must not silently bring the blocking stylesheet back.
        if (rewritten === 0 && /<link[^>]+rel="stylesheet"[^>]+href="\/(?!\/)/.test(html)) {
          throw new Error('acs-non-blocking-entry-stylesheet: the entry stylesheet tag was not recognised')
        }
        return result
      }
    }
  }
}

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
    plugins: [react(), nonBlockingEntryStylesheet()],
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
            // Non-English strings load on demand (src/modules/i18n/config.ts; English stays in the
            // entry). Each language is two chunks: its small `auth` namespace, which the always-mounted
            // auth provider and the sign-in screens read, and everything else, which only the IDE reads.
            // The Studio home then fetches ~1 KB of strings instead of the whole language, and opening
            // the IDE is still one request however many namespaces it reads.
            const locale = id.match(/\/src\/modules\/i18n\/locales\/([^/]+)\/([^/.]+)\.json/)
            if (locale && locale[1] !== 'en') return locale[2] === 'auth' ? `locale-${locale[1]}-auth` : `locale-${locale[1]}`
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
