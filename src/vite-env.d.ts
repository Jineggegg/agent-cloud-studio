/// <reference types="vite/client" />

/**
 * Installed package version, injected by Vite's `define` at build time.
 * Read it through `APP_VERSION` in `@/shared/constants`, which also covers
 * runners such as `tsx` that do not apply Vite's define replacement.
 */
declare const __APP_VERSION__: string;

/** Immutable identity of this browser bundle; null for a Vite development page. */
declare const __STUDIO_BUILD_INFO__: import('@/shared/types').StudioBuildInfo | null;
