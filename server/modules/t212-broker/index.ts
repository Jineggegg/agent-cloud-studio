// Trading 212 order broker: a standalone program that runs as its own OS user (studio-trader) and is the only
// holder of the order-capable key. Standalone-program exception to the shared-module rules: it is deployed as a
// root-owned copy outside the Studio checkout, so at runtime it imports only Node built-ins, better-sqlite3 and
// @simplewebauthn/server (type-only imports from @/shared/types.js are erased by the compiler; a test enforces
// this). No other module imports it: Studio talks to it over its unix socket (studio/trading212-broker.client.ts).
export { runBrokerCommand } from './broker.cli.js';
