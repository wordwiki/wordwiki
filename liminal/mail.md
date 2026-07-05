# Sending email (liminal/mail.ts)

Outbound email is a liminal feature shared by every app (rabid, wordwiki, …).
Call sites use a transport-agnostic `Mailer`; how a message is actually
delivered is a per-deploy configuration choice. This doc is the setup guide.
For the code, see [`mail.ts`](./mail.ts).

## TL;DR

- **Nothing configured** → the app uses a `LogMailer`: it *logs* each message
  (link and all) to the server console instead of sending. Local dev and
  un-provisioned deploys keep working; you just copy the link from the logs (or
  from the UI's copy box).
- **To actually send**, drop a git-ignored `<appName>-mail-credential.json` in
  the run dir with a Google Workspace **App Password**, and set
  `LIMINAL_PUBLIC_BASE_URL` in production. That's it — no code change.

## Provisioning Google Workspace (SMTP + App Password)

This is the low-setup path we run in production. It sends through Google's SMTP
using an *App Password* (basic-auth with your normal account password no longer
works over SMTP; App Passwords remain, and require 2-Step Verification).

1. **Pick/create a sending mailbox.** A dedicated user like
   `noreply@yourdomain.org` is cleanest. It must be a real Workspace *user*
   account (App Passwords aren't available for groups/aliases), and links/DKIM
   come from its domain.
2. **Turn on 2-Step Verification** for that mailbox
   (Google Account → Security → 2-Step Verification).
3. **Generate an App Password** at <https://myaccount.google.com/apppasswords>.
   Copy the 16-character value (Google shows it once).
4. **Write the credential file** (see below) using that App Password — *not* the
   account password.

Limits: `smtp.gmail.com` allows ~500 recipients/day per mailbox — far above our
volume (password-reset links). If that's ever not enough, see *Upgrade paths*.

## The credential file

`loadMailer(appName)` reads `<appName>-mail-credential.json` from the run
directory (the repo root for rabid). So:

- rabid → `rabid-mail-credential.json`
- wordwiki → `wordwiki-mail-credential.json`

Both are already git-ignored. **Never commit them.** Shape:

```json
{
  "transport": "smtp",
  "host": "smtp.gmail.com",
  "port": 465,
  "username": "noreply@yourdomain.org",
  "password": "<the 16-char app password>",
  "from": "Your Org <noreply@yourdomain.org>"
}
```

- `port` defaults to `465` (implicit TLS). For STARTTLS on `587`, set
  `"port": 587` and `"tls": false`.
- `from` should match the `username` mailbox (or one of its configured
  "Send mail as" addresses), or Google rewrites it.
- A missing / unreadable / malformed / incomplete file logs a warning and falls
  back to `LogMailer` — a broken credential never takes the server down.

Copy the file by hand onto each host (like the other repo-root secrets); it is
not distributed through git.

## Public link URL (production)

Emails contain absolute links (e.g. the password-reset URL). These come from
`LiminalApp.absoluteUrl(path)`, which prefers the `LIMINAL_PUBLIC_BASE_URL`
environment variable over the internally computed `http://host:port/`.

In production the app runs behind a reverse proxy (Caddy), so the internal base
is *not* the address a recipient can click. **Set the public URL explicitly:**

```sh
export LIMINAL_PUBLIC_BASE_URL="https://rabid.yourdomain.org"
```

In local dev you can leave it unset — links then use the dev origin
(`http://<checkout>.localhost:<port>/`).

## Verifying it works

- **Boot check:** on the first send the log prints either
  `mail: sending via SMTP smtp.gmail.com:465 as noreply@…` (configured) or a
  `mail: … using LogMailer` reason (not configured / bad file).
- **Dev / no credential:** trigger a send (e.g. a host generates a password-reset
  link) and read the console — `LogMailer` prints the full message including the
  link.
- **Real send:** with the credential present, the same action emails the
  recipient and the UI confirms "Emailed to …".

## What uses it

- **rabid password reset** (`rabid/rabid.ts` `resetLinkView`): a host generating
  a reset link now emails it to the volunteer; the copy-link box remains as a
  fallback delivery channel.
- New senders: read `app.mailer` (available on every `LiminalApp`) and call
  `await app.mailer.send({to, subject, text, html?})`. Build absolute links with
  `app.absoluteUrl(path)`. In tests, inject a `RecordingMailer`
  (`app.mailer = rec`) and assert on `rec.sent`.

## Upgrade paths (if we outgrow App Passwords)

The `Mailer` interface is transport-agnostic, so swapping the backend touches
only `mail.ts` — no call sites. Options, roughly in order of setup effort:

- **Gmail SMTP relay** (`smtp-relay.gmail.com`): ~10k recipients/day; needs
  Workspace admin routing config + a stable egress IP (or SMTP-auth) + DKIM.
- **Gmail API + single-mailbox OAuth**: HTTPS-only (no SMTP ports), a one-time
  OAuth consent, store a refresh token. No App Password.
- **Gmail API + service account + domain-wide delegation**: the most
  future-proof — no passwords, impersonate a `noreply@` sender over HTTPS.
  `gmail.send` is a *sensitive* (not *restricted*) scope, so no CASA assessment;
  an "Internal" app skips OAuth verification. More setup (GCP project + one
  Admin-console delegation) and JWT signing in code.

To add one, implement a new `Mailer` in `mail.ts` and branch on `transport` in
`loadMailer` (e.g. `"transport": "gmail-api"`).
