/**
 * A refusal the broker reports to its caller as `{ error, code }` with an HTTP status.
 *
 * Used by every file of the t212-broker module (config, repository, Trading 212 client, service, socket
 * server and CLI). It is not AppError from server/shared/utils.ts on purpose: the broker runs from a
 * root-owned copy as its own OS user and may import only Node built-ins, better-sqlite3 and
 * @simplewebauthn/server at runtime, so it keeps this small class instead of pulling in shared code.
 * Messages are short Chinese text for the owner and must never contain secrets.
 */
export class BrokerError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = 'BrokerError';
    this.statusCode = statusCode;
    this.code = code;
  }
}
