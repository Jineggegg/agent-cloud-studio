import React from 'react'
import ReactDOM from 'react-dom/client'

import App from '@/App'
import '@/index.css'

// Initialize i18n
import '@/modules/i18n'

// React Scan is a render-diagnostics overlay, and an expensive one: measured on
// this app it roughly halves the dev frame rate, adds ~14 MB of heap and injects
// a few thousand DOM nodes of its own. It is worth all of that while hunting a
// render bug and worth none of it the rest of the time, so it is opt-in —
// `localStorage.setItem('react-scan', 'on')` and reload. The import is dynamic and
// guarded by `import.meta.env.DEV`, so production builds never download its ~600 KB.
async function startRenderDiagnostics() {
  if (!import.meta.env.DEV) return
  let enabled = false
  try { enabled = localStorage.getItem('react-scan') === 'on' } catch { /* Storage blocked: stay off. */ }
  if (!enabled) return
  const { scan } = await import('react-scan')
  scan({ enabled: true })
}

// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Unable to mount the app: #root is missing from the document')
}

// Diagnostics must hook React before the first render; without them this resolves at once.
void startRenderDiagnostics().catch(() => {}).finally(() => {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})
