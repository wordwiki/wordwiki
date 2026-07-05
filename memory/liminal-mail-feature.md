---
name: liminal-mail-feature
description: "Shared outbound-email feature (liminal/mail.ts) — transport-agnostic Mailer, SMTP+app-password, LogMailer default; wired into rabid reset links"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5af7b4bf-e3c4-4084-a90c-b235feddb9df
---

Outbound email is a **liminal feature** (`liminal/mail.ts`), shared by rabid + wordwiki (dz: "all wordwiki needs this too"). Built 2026-07-05.

- `Mailer` interface (`send({to,subject,text,html?})` + `deliversRealMail`), backends: `SmtpMailer` (denomailer → Google Workspace over TLS, **app password** not account password), `LogMailer` (DEFAULT when unconfigured — logs the message/link, so dev + un-provisioned deploys still work), `RecordingMailer` (tests).
- `LiminalApp.mailer` getter lazily calls `loadMailer(appName)`, reading git-ignored `<appName>-mail-credential.json` (`{transport,host,port,username,password,from}`); absent/broken → LogMailer, never throws. Settable so tests inject a RecordingMailer.
- denomailer imported LAZILY via a non-literal specifier so it stays OUT of the module graph (tests/`deno check` never fetch it).
- Absolute links in email come from `LiminalApp.absoluteUrl(path)`, which prefers env `LIMINAL_PUBLIC_BASE_URL` (set to the real public https URL in prod, ahead of the reverse proxy) over the startup-computed `http://host:port/` base.
- Wired into `rabid.resetLinkView` (`rabid/rabid.ts`): mints the token, always attempts a send when the volunteer has an email, shows "Emailed to …" only when `deliversRealMail`; copy-link box stays as host fallback.
- **Setup doc: `liminal/mail.md`** (provisioning, credential-file shape, LIMINAL_PUBLIC_BASE_URL, upgrade paths).
- **To provision Google Workspace**: 2-Step Verification on a sending mailbox → app password at myaccount.google.com/apppasswords → drop into `rabid-mail-credential.json` (and `wordwiki-mail-credential.json`). Transport decision + options investigated in this session; chose SMTP+app-password (least setup) behind the swappable interface, Gmail-API service-account as the documented upgrade. See [[route-undeclared-bug-pattern]] (resetLinkView was also an undeclared route, fixed here).
