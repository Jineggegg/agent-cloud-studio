import { createCompressedAssetsHandler, createIndexHtmlHandler, createStaticCacheHeaders } from './web-client.routes.js';
import { createWebClientFileService } from './web-client.service.js';

type WebClientModuleOptions = {
  // The Vite build output (dist/).
  distDir: string;
};

/**
 * Builds the handlers that send the built web client: compressed, cached hashed bundles, the
 * cache headers for express.static's uncompressed fallback, and index.html for the SPA routes.
 */
export function createWebClientModule(options: WebClientModuleOptions) {
  const fileService = createWebClientFileService({ distDir: options.distDir });
  return {
    compressedAssets: createCompressedAssetsHandler(fileService),
    staticCacheHeaders: createStaticCacheHeaders(fileService),
    sendIndexHtml: createIndexHtmlHandler(fileService),
  };
}
