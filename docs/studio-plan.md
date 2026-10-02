# Agent Cloud Studio Plan

## Product

A personal, touch-friendly control surface, not a marketing site and not a
new trading engine. Use the existing upstream IDE rather than rewriting its
terminal, Git, file editor, or Claude/Codex runtimes.

The first screen prioritizes recent conversations, model entry points and
projects. iPad uses a persistent sidebar; phones use four bottom destinations.
Chat has stable toolbar/composer sizes. Controls have 44px targets, meaningful
labels, focus states, system appearance, reduced motion and safe-area support.

## Integration Boundaries

| Surface | v0.1 | Deliberately excluded |
| --- | --- | --- |
| Claude/Codex | Link to existing subscription workbench; inherited IDE preserved | Credential replacement or automatic provider switching |
| DeepSeek | Chat API, encrypted local key, history and connection test | Coding-agent tool execution or unapproved spending |
| SNR | Read-only health summary plus explicit launch of authenticated app gateway | Source edits, automatic training, strategy approval, trades |
| GitHub | Public fork with upstream remote | Personal data, account archives, keys, local databases |

The SNR connection was based on the local Strategy Laboratory under active
development, not on an assumed public website. Its health response currently
distinguishes research phase, approval and trading flags. Never turn successful
health checks or mock model tests into strategy-quality claims.

The gateway targets one administrator-configured loopback service and refuses
other hosts and unrelated paths. Users get a scoped, time-limited capability
only after Studio authentication. Mutation requests enforce origin checks
before being forwarded to SNR. No automatic network export of samples occurs.

## Development Order

1. Verify iPad/iPhone Safari navigation, keyboard, standalone web-app mode and
   SNR chart touch behavior on real devices.
2. Provision DeepSeek in the local UI and make one explicitly requested live
   test, then evaluate streaming and cost/usage display.
3. Add a provider adapter registry for additional OpenAI-compatible services;
   allowlisted endpoints, secrets and model discovery precede agent tools.
4. Add consent-based SNR context attachments: selected case and frozen
   snapshot only, with provenance and approval flags preserved.
5. Consolidate Claude/Codex runtimes inside Studio only after checking the
   actual machine/provider configuration, subscription auth and session replay.
6. Add task queue, approvals and mobile notifications with a durable job
   store; do not label mock jobs as running or completed.

## Verification

Run the focused Studio backend tests and client tests, typecheck, build and
lint. Check login protection, missing key, request failure, cancellation,
conversation ownership, credential redaction, fixed proxy targets and
cross-origin mutation rejection. Use desktop, iPad portrait/landscape, mobile,
dark mode and narrow-screen browser screenshots.

Automated browser emulation is not real Safari/Apple Pencil/microphone
acceptance. A saved key is not a verified provider connection, and a successful
models endpoint is not a successful chat completion.
