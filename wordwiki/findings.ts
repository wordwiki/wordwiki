/**
 * Structured findings reporting for batch migrators, validators and scans
 * (fix-orthographies.md "Findings publish path").
 *
 * The problem this solves: migrators and validators keep discovering things
 * and logging them to the console, where they get missed — and even when
 * caught, they have to be hand-reported to the language staff.  So findings
 * are STRUCTURED DATA reported through this API, not teed stdout: every call
 * BOTH prints to the console (nothing is lost there) and accumulates for a
 * curated markdown report.  Tee-ing the raw log would just re-bury findings
 * in the same noise, in HTML.
 *
 * One findings vocabulary, two renderers: `toMarkdown()` serializes a
 * point-in-time report (committed, served on staging); live report routes
 * can later render the same finding queries against the current db.
 *
 * Links: migrators never hand-build URLs — `lexemeLink` renders against the
 * report's configured base, so the same scan can emit app-relative links
 * (live routes) or absolute links at the legacy live server (cleanup reports
 * whose fixes are made there).
 */

/** One cell of a findings table. */
export type Cell = string | number;

export type SectionItem =
    | {kind: 'finding', text: string}
    | {kind: 'info', text: string}
    | {kind: 'table', header: string[], rows: Cell[][]};

export interface FindingsLinks {
    /** Prefix for lexeme links: '' for app-relative, or an absolute base
     *  (e.g. the legacy live server for staging cleanup reports). */
    lexemeBase?: string;
}

export interface FindingsReportOpts {
    /** Identification of the scanned db (path + purpose), for the banner. */
    sourceDb?: string;
    /** Stamp for the banner; defaults to now. */
    generatedAt?: Date;
    links?: FindingsLinks;
    /** Suppress the console echo (tests). */
    quiet?: boolean;
}

export class FindingsSection {
    items: SectionItem[] = [];

    constructor(public title: string, private echo: (line: string) => void) {
        echo('');
        echo(`== ${title} ==`);
    }

    /** A curated finding — something a human should act on or decide about. */
    finding(text: string): void {
        this.items.push({kind: 'finding', text});
        this.echo(`FINDING: ${text}`);
    }

    /** Narrative context ("checked 21,384 rows") — reported, not counted. */
    info(text: string): void {
        this.items.push({kind: 'info', text});
        this.echo(text);
    }

    table(header: string[], rows: Cell[][]): void {
        this.items.push({kind: 'table', header, rows});
        const widths = header.map((h, c) =>
            Math.max(String(h).length, ...rows.map(r => String(r[c] ?? '').length)));
        const fmt = (cells: Cell[]) =>
            '  ' + cells.map((v, c) => String(v ?? '').padEnd(widths[c])).join('  ').trimEnd();
        this.echo(fmt(header));
        for(const row of rows) this.echo(fmt(row));
    }

    get findingCount(): number {
        return this.items.filter(i => i.kind === 'finding').length;
    }
}

export class FindingsReport {
    sections: FindingsSection[] = [];
    readonly generatedAt: Date;

    constructor(public title: string, public opts: FindingsReportOpts = {}) {
        this.generatedAt = opts.generatedAt ?? new Date();
    }

    #echo = (line: string) => { if(!this.opts.quiet) console.info(line); };

    section(title: string): FindingsSection {
        const s = new FindingsSection(title, this.#echo);
        this.sections.push(s);
        return s;
    }

    /** A markdown lexeme link against the configured base. */
    lexemeLink(entry_id: number, text: string): string {
        const base = this.opts.links?.lexemeBase ?? '';
        return `[${mdEscape(text)}](${base}/ww/wordwiki.entry(${entry_id}))`;
    }

    get findingCount(): number {
        return this.sections.reduce((n, s) => n + s.findingCount, 0);
    }

    /**
     * The point-in-time markdown report: prominent generated-at banner,
     * per-section finding counts, then the sections.
     */
    toMarkdown(): string {
        const out: string[] = [];
        out.push(`# ${this.title}`, '');
        out.push(`> **⚠ Point-in-time report — generated ${this.generatedAt.toISOString()}` +
                 `${this.opts.sourceDb ? ` from \`${this.opts.sourceDb}\`` : ''}.**`);
        out.push(`> This is a record of that moment, not a live view; re-run the generator for current data.`, '');
        out.push(`**${this.findingCount} finding(s)** across ${this.sections.length} section(s):`, '');
        for(const s of this.sections)
            out.push(`- ${s.title}: ${s.findingCount} finding(s)`);
        for(const s of this.sections) {
            out.push('', `## ${s.title}`, '');
            for(const item of s.items) {
                switch(item.kind) {
                    case 'finding': out.push(`- **${item.text}**`); break;
                    case 'info':    out.push(`- ${item.text}`); break;
                    case 'table': {
                        out.push('');
                        out.push(`| ${item.header.map(h => mdCell(h)).join(' | ')} |`);
                        out.push(`|${item.header.map(() => '---').join('|')}|`);
                        for(const row of item.rows)
                            out.push(`| ${row.map(c => mdCell(c)).join(' | ')} |`);
                        out.push('');
                        break;
                    }
                }
            }
        }
        out.push('');
        return out.join('\n');
    }
}

function mdCell(v: Cell): string {
    return String(v ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function mdEscape(text: string): string {
    return text.replaceAll('[', '\\[').replaceAll(']', '\\]');
}
