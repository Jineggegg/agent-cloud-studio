import type { Server as HttpServer } from 'node:http';
import net from 'node:net';

/**
 * Opens the dedicated loopback listener for cloudflared (STUDIO_CLOUDFLARED_PORT,
 * docs/security.md) and hands every connection to the main HTTP server, so routes, WebSockets,
 * timeouts and limits are exactly the same; only the connection's local port differs, which is
 * how the auth module tells public-door traffic apart from Tailscale Serve and local programs.
 * It binds 127.0.0.1 only and caps its own connections like the main server does.
 * Used by the server entrypoint once the main server listens; resolves when the port is bound.
 */
export function startCloudflaredListener(
  server: HttpServer,
  port: number,
  options: { host?: string; maxConnections?: number } = {},
): Promise<net.Server> {
  const listener = net.createServer((socket) => {
    server.emit('connection', socket);
  });
  if (options.maxConnections) listener.maxConnections = options.maxConnections;
  return new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, options.host ?? '127.0.0.1', () => {
      listener.off('error', reject);
      resolve(listener);
    });
  });
}
