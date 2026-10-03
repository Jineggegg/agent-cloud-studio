/**
 * Whether opening Studio lands in the Harness app instead of the home screen: a per-device setting (Settings →
 * 主屏幕), on unless turned off, applied once per launch so coming back to the home screen is not undone by a reload.
 */

const HARNESS_ON_LAUNCH_KEY = 'studio-harness-on-launch';
// Set in this tab's session once the launch has been redirected; an iPad web app gets a fresh session per launch.
const HARNESS_LAUNCHED_KEY = 'studio-harness-launched';

/** Used by Settings → 主屏幕 and by takeHarnessLaunch: this device's choice, on by default. */
export function readHarnessOnLaunch(): boolean {
  try { return localStorage.getItem(HARNESS_ON_LAUNCH_KEY) !== 'off'; } catch { return true; }
}

/** Used by Settings → 主屏幕 to save this device's choice. */
export function writeHarnessOnLaunch(on: boolean) {
  try { localStorage.setItem(HARNESS_ON_LAUNCH_KEY, on ? 'on' : 'off'); } catch { /* Private mode: the default stays. */ }
}

/**
 * Used by StudioPage when Studio opens on `/`: true the first time in this launch while the setting is on (and marks
 * the launch as taken), false afterwards, so a reload or a later visit to the home screen stays put.
 */
export function takeHarnessLaunch(): boolean {
  if (!readHarnessOnLaunch()) return false;
  try {
    if (sessionStorage.getItem(HARNESS_LAUNCHED_KEY)) return false;
    sessionStorage.setItem(HARNESS_LAUNCHED_KEY, '1');
    return true;
  } catch {
    // Without session storage there is no way to tell a reload from a launch; the home screen is the safe answer.
    return false;
  }
}
