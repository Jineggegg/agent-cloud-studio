import type { ServerResponse } from 'node:http';
import path from 'node:path';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { createWebClientFileService } from './web-client.service.js';

type WebClientFileService = ReturnType<typeof createWebClientFileService>;

// Hashed bundles never change under their name, so browsers may keep them for good.
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
// index.html names the current bundles: browsers keep a copy but revalidate it (a cheap 304) on every
// launch, so a rebuild is picked up at once.
const REVALIDATE_CACHE_CONTROL = 'no-cache';

/**
 * Picks the response encoding from an Accept-Encoding header: brotli when offered, else gzip, else
 * none. Honours `q=0` refusals and the `*` wildcard.
 */
function negotiateEncoding(acceptEncoding: string | undefined): 'br' | 'gzip' | null {
  if (!acceptEncoding) return null;
  const accepted = new Map<string, number>();
  for (const part of acceptEncoding.split(',')) {
    const [name, ...parameters] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const quality = parameters.map(parameter => parameter.trim()).find(parameter => parameter.startsWith('q='));
    const weight = quality ? Number.parseFloat(quality.slice(2)) : 1;
    accepted.set(name, Number.isFinite(weight) ? weight : 0);
  }
  const isAccepted = (encoding: string) => (accepted.get(encoding) ?? accepted.get('*') ?? 0) > 0;
  if (isAccepted('br')) return 'br';
  if (isAccepted('gzip')) return 'gzip';
  return null;
}

function sendCompressed(
  request: Request,
  response: Response,
  filePath: string,
  encoding: 'br' | 'gzip',
  file: { body: Buffer; etag: string },
  cacheControl: string,
): void {
  response.type(path.extname(filePath));
  response.setHeader('Content-Encoding', encoding);
  response.vary('Accept-Encoding');
  response.setHeader('Cache-Control', cacheControl);
  response.setHeader('ETag', file.etag);
  if (request.fresh) {
    response.status(304).end();
    return;
  }
  response.setHeader('Content-Length', String(file.body.length));
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  response.end(file.body);
}

/**
 * Used by createWebClientModule, mounted by the server entrypoint ahead of express.static over dist/.
 * Serves `/assets/*` bundles brotli- or gzip-compressed when the browser accepts it, cached in memory
 * and marked immutable. Anything it does not handle (other paths, binary files, no accepted encoding,
 * a failed compression) falls through to express.static, which sends the file as it is.
 */
export function createCompressedAssetsHandler(fileService: WebClientFileService): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return next();
    const encoding = negotiateEncoding(request.headers['accept-encoding']);
    const filePath = encoding ? fileService.resolveAssetPath(request.path) : null;
    if (!encoding || !filePath) return next();
    try {
      const file = await fileService.getCompressedFile(filePath, encoding);
      if (!file) return next();
      sendCompressed(request, response, filePath, encoding, file, IMMUTABLE_CACHE_CONTROL);
    } catch (error) {
      console.warn('[web-client] Sending an asset uncompressed:', error instanceof Error ? error.message : error);
      next();
    }
  };
}

/**
 * Used by createWebClientModule for the server entrypoint's SPA catch-all: sends dist/index.html,
 * compressed when accepted and revalidated on every launch. Errors (for example a build removed
 * mid-request) go to the global error handler.
 */
export function createIndexHtmlHandler(fileService: WebClientFileService): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction) => {
    const encoding = negotiateEncoding(request.headers['accept-encoding']);
    if (encoding) {
      try {
        const file = await fileService.getCompressedFile(fileService.indexHtmlPath, encoding);
        if (file) {
          sendCompressed(request, response, fileService.indexHtmlPath, encoding, file, REVALIDATE_CACHE_CONTROL);
          return;
        }
      } catch (error) {
        console.warn('[web-client] Sending index.html uncompressed:', error instanceof Error ? error.message : error);
      }
    }
    response.vary('Accept-Encoding');
    response.setHeader('Cache-Control', REVALIDATE_CACHE_CONTROL);
    response.sendFile(fileService.indexHtmlPath, (error) => {
      if (error) next(error);
    });
  };
}

/**
 * Used by createWebClientModule as the server entrypoint's `setHeaders` for express.static over dist/
 * (the uncompressed path): hashed assets are immutable, HTML is revalidated, and compressible assets
 * announce that the response varies by encoding.
 */
export function createStaticCacheHeaders(fileService: WebClientFileService) {
  return (response: ServerResponse, filePath: string): void => {
    if (filePath.endsWith('.html')) {
      response.setHeader('Cache-Control', REVALIDATE_CACHE_CONTROL);
      return;
    }
    if (!fileService.isHashedAsset(filePath)) return;
    response.setHeader('Cache-Control', IMMUTABLE_CACHE_CONTROL);
    if (fileService.isCompressible(filePath)) response.setHeader('Vary', 'Accept-Encoding');
  };
}
