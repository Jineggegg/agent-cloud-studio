# Modular Studio Projects

Studio adds a project tree without changing the SNR laboratory. Each personal
project has an editable name, description, native workspace directory, enabled
providers, and independent agents/mail/automation module switches.

## Agent Workspaces

Claude and GPT / Codex use the existing subscription-authenticated native
workbench. Opening an assistant registers an existing workspace directory and
passes its native project ID and provider to `/workspace`. No model is invoked
until a message is submitted.

The platform remains a personal, host-level workbench: native CLI directories
and sessions retain the inherited application's access model. Studio project
configuration and Gmail credentials are user-bound; this feature does not turn
the native IDE into a multi-tenant filesystem sandbox.

SNR names and directories are rejected by the custom project interface.
Canonical paths are checked before opening native workspaces, including
symlinks. No SNR service, dataset, trading rule or strategy code is modified.

## Read-Only Gmail

Configure these variables on the server, not in browser JavaScript:

```env
STUDIO_PUBLIC_ORIGIN=https://your-platform-host
STUDIO_GMAIL_CLIENT_ID=
STUDIO_GMAIL_CLIENT_SECRET=
```

Enable the Gmail API for a Google OAuth application. Register
`<STUDIO_PUBLIC_ORIGIN>/api/studio/gmail/callback` as its redirect URI. Configure
the consent screen and test users according to the application's Google
publication status, then connect each project's mailbox from its Mail tab.

The integration requests only `gmail.readonly`. OAuth uses an expiring, one-use
state bound to the signed-in user and project, plus PKCE. Access and refresh
tokens are encrypted with AES-256-GCM in the existing Studio vault directory.
Tokens are never returned by project or connection-status APIs.

Search returns at most 20 messages with headers and snippets. Plain-text body
content is fetched only when a message is opened. Attachments are not fetched,
HTML is not executed, messages are not marked as read, and no email is sent.
The existing SMTP `.env` is not imported or opened by this feature.

Saving a summary creates an automation **draft**, not a model invocation.
Search-result drafts explicitly identify their input as snippets rather than
full messages. Email text is labelled as untrusted source material in the draft.

## Automation

Drafts contain a name, enabled provider and instructions. Saving a draft does
not start a model, schedule a job or send email.

One-time execution reuses the existing scheduled-message dispatcher. The user
must choose an existing session belonging to the same project and provider,
choose a future instant, and explicitly confirm scheduling. The review displays
the submitted instructions. Existing scheduler entries can be cancelled.
Disabling execution modules/providers or switching a directory is blocked while
that directory has pending jobs, so disabling a visible module cannot conceal
an already scheduled execution.

Recurring schedules, automatic inbox monitoring and outgoing email digests are
not enabled by this change. Agent execution retains the native workbench's
approval model; automation is not a new blanket grant of tool permissions.

## Verification

Backend tests cover project ownership, reserved SNR names, provider/module
validation, draft-only saving, project/provider matching, OAuth state replay,
PKCE, encrypted token storage, read-only HTTP calls and sanitized errors.
Frontend tests cover saved module switches, disconnected states, explicit
search, summary drafts and the native project/provider deep link.

Use an independent `DATABASE_PATH`, backend port and Vite port for previews.
Do not reuse production credentials or copy a production database into a
preview. Production Gmail authorization and real provider execution require
separate acceptance after deployment.
