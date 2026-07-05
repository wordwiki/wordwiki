// deno-lint-ignore-file no-explicit-any
/**
 * Outbound email as a liminal feature (shared by rabid + wordwiki).
 *
 * A transport-agnostic `Mailer` with a swappable backend so call sites never
 * care how a message is delivered:
 *
 *   - SmtpMailer      - denomailer -> an SMTP server over TLS, authenticated
 *                       with a username + password.  For Google Workspace the
 *                       password is an APP PASSWORD, not the account password
 *                       (basic auth over SMTP was retired in 2025; app passwords
 *                       remain, and require 2-Step Verification on the mailbox).
 *   - LogMailer       - the DEFAULT when no credential is configured: logs the
 *                       message (link and all) instead of sending, so local dev
 *                       and un-provisioned deploys keep working - the org's prior
 *                       "generate a link, hand it over yourself" behaviour.
 *   - RecordingMailer - in-memory capture for tests (no I/O).
 *
 * Configuration lives in a git-ignored `<appName>-mail-credential.json` in the
 * run dir, read once by loadMailer():
 *
 *   {
 *     "transport": "smtp",
 *     "host":     "smtp.gmail.com",
 *     "port":     465,
 *     "username": "noreply@yourdomain.org",
 *     "password": "<google app password>",          // NOT the account password
 *     "from":     "Your Org <noreply@yourdomain.org>"
 *   }
 *
 * A missing / unreadable / malformed / incomplete file degrades to a LogMailer
 * (loadMailer NEVER throws): a broken mail credential must not take the server
 * down, and a not-yet-provisioned deploy should still generate reset links.
 *
 * To mint the Google app password: turn on 2-Step Verification for the sending
 * mailbox, then create one at https://myaccount.google.com/apppasswords .
 *
 * Note on link URLs in emails: absolute links come from LiminalApp.absoluteUrl,
 * which prefers the LIMINAL_PUBLIC_BASE_URL env var (set this to the real public
 * https URL in production, e.g. https://rabid.example.org) over the internally
 * computed http://host:port/ base.  Otherwise emailed links would point at the
 * internal origin behind the reverse proxy.
 */

export interface OutgoingMail {
    to: string;
    subject: string;
    text: string;       // plain-text body - always provided (the accessible default)
    html?: string;      // optional richer body
}

export interface Mailer {
    /** Deliver one message.  Implementations throw on hard failure so callers
     *  can decide whether a send failure is fatal to their flow. */
    send(mail: OutgoingMail): Promise<void>;
    /** True only for transports that actually deliver to the outside world
     *  (false for LogMailer / RecordingMailer), so UI can honestly report
     *  whether a message was really sent. */
    readonly deliversRealMail: boolean;
}

export interface SmtpMailerConfig {
    host: string;
    port: number;
    username: string;
    password: string;
    from: string;
    /** Implicit TLS (default true, the port-465 setup).  false => STARTTLS on
     *  e.g. port 587. */
    tls?: boolean;
}

// denomailer is imported LAZILY, and via a specifier the static analyzer can't
// fold to a literal, so it stays OUT of the module graph: the default path is
// LogMailer, tests never send real mail, and we don't want a third-party SMTP
// library fetched or type-checked on every `deno check` / `deno test`.  Only a
// configured SmtpMailer.send() ever pulls it in.
const DENOMAILER_URL = ['https://deno.land/x/', 'denomailer@1.6.0/mod.ts'].join('');

export class SmtpMailer implements Mailer {
    readonly deliversRealMail = true;
    constructor(private config: SmtpMailerConfig) {}

    async send(mail: OutgoingMail): Promise<void> {
        const { SMTPClient } = await import(DENOMAILER_URL) as any;
        // A fresh connection per message: this is a very-low-volume path
        // (password resets), so a pooled/long-lived socket isn't worth the
        // liveness risk (idle SMTP sockets get dropped by the server).
        const client = new SMTPClient({
            connection: {
                hostname: this.config.host,
                port: this.config.port,
                tls: this.config.tls ?? true,
                auth: {username: this.config.username, password: this.config.password},
            },
        });
        try {
            await client.send({
                from: this.config.from,
                to: mail.to,
                subject: mail.subject,
                content: mail.text,
                ...(mail.html ? {html: mail.html} : {}),
            });
        } finally {
            await client.close();
        }
    }
}

export class LogMailer implements Mailer {
    readonly deliversRealMail = false;
    constructor(private reason: string = 'no mail credential configured') {}

    // deno-lint-ignore require-await
    async send(mail: OutgoingMail): Promise<void> {
        console.info(
            `[mail: LogMailer - ${this.reason}] NOT sending; would have sent:\n` +
            `  to:      ${mail.to}\n` +
            `  subject: ${mail.subject}\n` +
            `  ${mail.text.replace(/\n/g, '\n  ')}`);
    }
}

/** In-memory Mailer for tests: records sends, delivers nothing.  Stands in for
 *  a real transport, so deliversRealMail defaults to true (override for the
 *  "no real delivery configured" case). */
export class RecordingMailer implements Mailer {
    readonly sent: OutgoingMail[] = [];
    constructor(readonly deliversRealMail: boolean = true) {}

    // deno-lint-ignore require-await
    async send(mail: OutgoingMail): Promise<void> { this.sent.push(mail); }

    get last(): OutgoingMail | undefined { return this.sent[this.sent.length - 1]; }
}

interface MailCredentialFile {
    transport?: string;    // 'smtp' (the only backend for now); defaulted
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    from?: string;
    tls?: boolean;
}

/**
 * Build the app's Mailer from `<appName>-mail-credential.json` in the run dir.
 * Returns a LogMailer (never throws) when the file is absent, unreadable,
 * unparseable, of an unsupported transport, or missing required fields - so a
 * missing or broken credential degrades to "log the message" rather than a
 * crash.
 */
export function loadMailer(appName: string): Mailer {
    const file = `${appName}-mail-credential.json`;
    let raw: string;
    try {
        raw = Deno.readTextFileSync(file);
    } catch {
        return new LogMailer(`no ${file}`);
    }
    let cred: MailCredentialFile;
    try {
        cred = JSON.parse(raw);
    } catch (e) {
        console.error(`mail: ${file} is not valid JSON (${e}); using LogMailer`);
        return new LogMailer(`unparseable ${file}`);
    }
    const transport = cred.transport ?? 'smtp';
    if(transport !== 'smtp') {
        console.error(`mail: ${file} transport '${transport}' is not supported; using LogMailer`);
        return new LogMailer(`unsupported transport in ${file}`);
    }
    const missing = (['host', 'username', 'password', 'from'] as const)
        .filter(k => typeof cred[k] !== 'string' || cred[k] === '');
    if(missing.length) {
        console.error(`mail: ${file} is missing ${missing.join(', ')}; using LogMailer`);
        return new LogMailer(`incomplete ${file}`);
    }
    console.info(`mail: sending via SMTP ${cred.host}:${cred.port ?? 465} as ${cred.username}`);
    return new SmtpMailer({
        host: cred.host!,
        port: cred.port ?? 465,
        username: cred.username!,
        password: cred.password!,
        from: cred.from!,
        tls: cred.tls,
    });
}
