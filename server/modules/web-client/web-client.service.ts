import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

// Text formats worth compressing. Images, fonts (woff2 is compressed already) and media go out as they are.
const COMPRESSIBLE_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.txt', '.map', '.xml', '.wasm', '.webmanifest']);

// Below this the headers outweigh what compression saves.
const MIN_COMPRESSIBLE_BYTES = 1024;

// Brotli quality 9 lands within ~8% of the maximum (11) on these bundles at about a twentieth of the
// CPU time, so the first request after a restart is not held up for a second per large chunk.
const BROTLI_QUALITY = 9;

// Upper bound for the compressed copies kept in memory. A build's assets need a few MB per encoding;
// the bound only matters when rebuilds pile up files that a long-running process keeps being asked for.
const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;

type WebClientFileServiceOptions = {
  // The Vite build output (dist/) holding index.html and the hashed assets/ directory.
  distDir: string;
  maxCacheBytes?: number;
};

// One compressed copy of one file, tied to the size and mtime it was made from.
type CompressedCacheEntry = {
  size: number;
  mtimeMs: number;
  body: Promise<Buffer>;
  bytes: number;
};

async function compressFile(filePath: string, encoding: 'br' | 'gzip'): Promise<Buffer> {
  const contents = await fs.readFile(filePath);
  if (encoding === 'gzip') {
    return gzip(contents, { level: zlib.constants.Z_BEST_COMPRESSION });
  }
  return brotliCompress(contents, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: contents.length,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    },
  });
}

/**
 * Compresses the built web client's files for the server entrypoint's static handlers (through the
 * web-client module) and keeps the results in memory, so each hashed bundle is compressed once per
 * process instead of on every request. Every lookup re-checks the file's size and mtime, so a rebuild
 * without a restart (index.html keeps its name) never serves stale bytes.
 */
export function createWebClientFileService(options: WebClientFileServiceOptions) {
  const distDir = path.resolve(options.distDir);
  const assetsDir = path.join(distDir, 'assets');
  const indexHtmlPath = path.join(distDir, 'index.html');
  const maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
  // Keyed by `${encoding}:${absolute path}`; Map order doubles as insertion age for trimming.
  const cache = new Map<string, CompressedCacheEntry>();
  let cachedBytes = 0;

  const forget = (key: string) => {
    const entry = cache.get(key);
    if (!entry) return;
    cachedBytes -= entry.bytes;
    cache.delete(key);
  };

  // Oldest first; the entry just added is kept even when it alone exceeds the bound.
  const trimCache = (keepKey: string) => {
    for (const key of cache.keys()) {
      if (cachedBytes <= maxCacheBytes) return;
      if (key !== keepKey) forget(key);
    }
  };

  return {
    indexHtmlPath,

    /** True for files under dist/assets: Vite names them by content hash, so they never change. */
    isHashedAsset(filePath: string): boolean {
      return path.resolve(filePath).startsWith(assetsDir + path.sep);
    },

    /** Whether a file of this type is sent compressed when the browser accepts it. */
    isCompressible(filePath: string): boolean {
      return COMPRESSIBLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
    },

    /**
     * Maps a request path such as `/assets/index-abc.js` to its file in dist/assets, or null when the
     * path is not an asset path or could point outside that directory (`..`, encoded separators, NUL).
     */
    resolveAssetPath(requestPath: string): string | null {
      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(requestPath);
      } catch {
        return null;
      }
      if (!decodedPath.startsWith('/assets/') || decodedPath.includes('\0')) return null;
      const filePath = path.resolve(distDir, `.${decodedPath}`);
      return filePath.startsWith(assetsDir + path.sep) ? filePath : null;
    },

    /**
     * The file compressed with `encoding`, with an ETag naming that exact variant; null when the file is
     * missing, not a compressible type or too small to bother (the caller then sends it as it is).
     * Concurrent requests for the same file share one compression. Rejects if compression fails.
     */
    async getCompressedFile(filePath: string, encoding: 'br' | 'gzip'): Promise<{ body: Buffer; etag: string } | null> {
      if (!COMPRESSIBLE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return null;
      const key = `${encoding}:${filePath}`;
      let stats;
      try {
        stats = await fs.stat(filePath);
      } catch {
        forget(key);
        return null;
      }
      if (!stats.isFile() || stats.size < MIN_COMPRESSIBLE_BYTES) return null;

      let entry = cache.get(key);
      if (!entry || entry.size !== stats.size || entry.mtimeMs !== stats.mtimeMs) {
        forget(key);
        const created: CompressedCacheEntry = { size: stats.size, mtimeMs: stats.mtimeMs, body: compressFile(filePath, encoding), bytes: 0 };
        cache.set(key, created);
        created.body.then((body) => {
          if (cache.get(key) !== created) return;
          created.bytes = body.length;
          cachedBytes += body.length;
          trimCache(key);
        }, () => {
          // A failed compression is not cached; the next request tries again.
          if (cache.get(key) === created) cache.delete(key);
        });
        entry = created;
      }

      const body = await entry.body;
      const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}-${encoding}"`;
      return { body, etag };
    },
  };
}
