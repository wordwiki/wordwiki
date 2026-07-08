// deno-lint-ignore-file no-explicit-any
/**
 * The wordwiki COMMAND LINE: `serve` plus the import/migration pipeline
 * subcommands (importWordWikiV1Db.sh drives these; see the per-case comments).
 *
 * Extracted verbatim from wordwiki.ts's import.meta.main block - wordwiki.ts
 * is still the entry point wordwiki.sh runs, and it delegates here (via a
 * dynamic import, so wordwiki.ts <-> cli.ts is not a static module cycle).
 */
import {db} from "../liminal/db.ts";
import {panic} from '../liminal/utils.ts';
import * as security from '../liminal/security.ts';
import * as schemaUpgrade from '../liminal/schema-upgrade.ts';
import * as templates from './templates.ts';
import * as entry from './entry-schema.ts';
import * as orthography from './orthography.ts';
import * as user from './user.ts';
import * as categoryImport from './category-import.ts';
import * as twitterPostImport from './twitter-post-import.ts';
import * as lexicalFormImport from './lexical-form-import.ts';
import * as migrationVerify from './migration-verify.ts';
import * as instanceDir_ from './instance-dir.ts';
import * as publish from './publish.ts';
import { validateVersionedDb, validateVariantInvariants,
         factViewsFromVersionedDb } from './versioned-db-validate.ts';
import { variantPolicyByTag } from './variant-policy.ts';
import { FindingsReport, assembleImportReport } from './findings.ts';
import { scanVariants } from './variant-scan.ts';
import { migrateVariants } from './variant-migrate.ts';
import { migrateStatus } from './status-migrate.ts';
import { pairJunkReason } from './auto-transliterate.ts';
import { repairAssertions } from './repair-assertions.ts';
import { backfillPublication } from './publication-backfill.ts';
import { normalizeShoeboxDates } from './creation-dates.ts';
import { getWordWiki, createAllTables } from './wordwiki.ts';
import { buildPublishSource } from './publish-source.ts';

export async function cliMain(args: string[]): Promise<void> {
    const command = args[0];
    const ww = getWordWiki();

    // The FINDINGS PUBLISH PATH (fix-orthographies.md): every pipeline
    // subcommand accepts --report <path.md>; the migrator's own LOG CALLBACK
    // (never raw stdout - the db layer's noise stays out by construction)
    // accumulates into a findings fragment alongside the console echo, and a
    // CRASH still writes the fragment with the error as a finding - so the
    // assembled import report always tells the whole story.
    // --report=<path> (preferred: never collides with positional args) or
    // --report <path>.
    const reportPathArg = (): string | undefined => {
        const eq = args.find(a => a.startsWith('--report='));
        if(eq) return eq.slice('--report='.length);
        const i = args.indexOf('--report');
        return i >= 0 ? args[i + 1] : undefined;
    };
    const dbDescription = () =>
        `${(()=>{try{return Deno.realPathSync('database/db.db');}catch{return 'database/db.db';}})()} [db_purpose: ${ww.getDbPurpose() ?? 'unmarked'}]`;
    const stepReport = (title: string) => {
        const report = new FindingsReport(title, {sourceDb: dbDescription()});
        const section = report.section('Log');
        const reportPath = reportPathArg();
        const write = () => { if(reportPath) Deno.writeTextFileSync(reportPath, report.toMarkdown()); };
        return {
            report,
            log: (m: string) => section.info(m),
            finish: write,
            crash: (e: unknown) => {
                report.section('CRASHED').finding(
                    `step failed: ${e instanceof Error ? e.message : String(e)}`);
                write();
            },
        };
    };
    switch(command) {
        case 'serve': {
            const port = Number(Deno.env.get('WORDWIKI_PORT') ?? '9000');
            const instanceDir = Deno.cwd();

            // Verify the instance is actually set up (don't silently serve an
            // empty/mis-pointed dir), then take the db write-lock.
            const {errors, warnings} = instanceDir_.checkInstanceStores(instanceDir);
            for(const w of warnings) console.warn(`WARNING: instance store ${w}`);
            if(errors.length > 0) {
                console.error(`wordwiki instance dir '${instanceDir}' is not set up - refusing to start:`);
                for(const e of errors) console.error(`  ${e}`);
                Deno.exit(1);
            }
            instanceDir_.acquireDbLock(instanceDir);

            // Both are idempotent (all IF NOT EXISTS): createAllTables also
            // APPLIES NEW INDEX LINES to an existing db - without it a new
            // index in createAssertionDml never reaches long-lived instances
            // (this bit the fixed valid_to partial indexes once already).
            security.runSystem(() => { ww.ensureNewStyleTables(); createAllTables(); });

            // Announce exactly which instance/db/port we are on (so a glance at
            // the log catches "I thought this was the dev/prod instance").
            console.info(`wordwiki serving:`);
            console.info(`  instance dir : ${instanceDir}`);
            console.info(`  database     : ${(()=>{try{return Deno.realPathSync('database/db.db');}catch{return 'database/db.db';}})()}  [db_purpose: ${ww.getDbPurpose() ?? 'unmarked'}]`);
            console.info(`  port         : ${port}`);

            // Legacy-template pages don't go through coercePageResult, so the
            // navbar's test-client-link default is set once here instead.
            templates.setDefaultShowTestClientLink(ww.isTestDb);
            ww.startServer({hostname: 'localhost', port,
                            allowSchemaMismatch: args.includes('--allow-schema-mismatch')});
            break;
        }

        // Compare the db against the declared (new-style) table model; with
        // --apply, bring it up to date (additive changes only - see
        // liminal/schema-upgrade.ts; a backup is taken first).  The legacy
        // raw-DML tables (scanned documents, dict, ...) are not covered: they
        // show up as ignorable notes.  Stop the server before --apply.
        case 'upgrade-db': {
            const code = security.runSystem(() =>
                schemaUpgrade.upgradeDbCommand(ww.tables, args.slice(1)));
            Deno.exit(code);
            break;
        }

        // One-time migration: replace the old (never-used) raw-DML user table
        // with the new liminal-style one and seed it from the hardcoded users
        // map in entry-schema.ts.  Refuses if the old table has rows.
        case 'upgrade-users': {
            security.runSystem(() => {
                const userCount = (() => {
                    try { return db().prepare<{n: number}, {}>('SELECT COUNT(*) AS n FROM user').required({}).n; }
                    catch (_e) { return 0; }  // no user table at all
                })();
                const hasNewShape = (() => {
                    try { db().prepare('SELECT permissions FROM user LIMIT 1').all({}); return true; }
                    catch (_e) { return false; }
                })();
                if(userCount > 0 && !hasNewShape)
                    throw new Error(`user table has ${userCount} rows but the OLD schema - migrate manually`);
                if(!hasNewShape) {
                    console.info('dropping old-style empty user table');
                    db().execute('DROP TABLE IF EXISTS user', {});
                }
                ww.ensureNewStyleTables();
                const {inserted, skipped} = user.seedUsersFromEntrySchema(ww.users);
                const pw = user.seedPasswordsFromFile(ww.users, ww.passwordHash,
                    new URL('../user-passwords.json', import.meta.url).pathname);
                console.info(`user table upgraded: ${inserted} users seeded, ${skipped} already present, ` +
                             `${pw.set} passwords seeded (${pw.kept} already set)`);
                console.info('set a password with: wordwiki.ts set-password <username> <password>');
            });
            Deno.exit(0);
            break;
        }

        // Set (or replace) a user's password.  Run with the server stopped
        // (SQLite single writer).
        case 'set-password': {
            const [username, password] = [args[1], args[2]];
            if(!username || !password)
                throw new Error('usage: set-password <username> <password>');
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                const u = ww.users.byUsername.first({username})
                    ?? panic(`no user with username '${username}' (run upgrade-users first?)`);
                ww.passwordHash.setPassword(u.user_id, password);
                console.info(`password set for ${u.name} (${username})`);
            });
            Deno.exit(0);
            break;
        }

        // Everything a freshly-pulled PRODUCTION db needs to run as the dev
        // db: upgrade/seed the user table (production still has the old empty
        // one), seed passwords from user-passwords.json, and mark the db
        // 'dev'.  Re-run after every pull until the new version IS production.
        //   ./wordwiki.sh post-pull
        // Stop the server and nothing else.  (wordwiki.sh stops any running
        // server before dispatching ANY command, so by the time we get here
        // the work is done - this command just gives the stop a name for
        // scripts like importWordWikiV1Db.sh.)
        case 'stop':
            console.info('server stopped (if one was running)');
            Deno.exit(0);
            break;

        case 'post-pull': {
            security.runSystem(() => {
                // Same logic as upgrade-users: replace an old-shape (empty)
                // user table, create anything missing, seed from the
                // entry-schema users map (idempotent - existing rows kept).
                const hasNewShape = (() => {
                    try { db().prepare('SELECT permissions FROM user LIMIT 1').all({}); return true; }
                    catch (_e) { return false; }
                })();
                if(!hasNewShape) {
                    const userCount = (() => {
                        try { return db().prepare<{n: number}, {}>('SELECT COUNT(*) AS n FROM user').required({}).n; }
                        catch (_e) { return 0; }
                    })();
                    if(userCount > 0)
                        throw new Error(`user table has ${userCount} rows but the OLD schema - migrate manually`);
                    console.info('dropping old-style empty user table');
                    db().execute('DROP TABLE IF EXISTS user', {});
                }
                ww.ensureNewStyleTables();
                const {inserted, skipped} = user.seedUsersFromEntrySchema(ww.users);
                // Everyone (including the 'test' user) keeps the password
                // from the (never-checked-in) user-passwords.json - fills in
                // only users with no password yet.
                const pw = user.seedPasswordsFromFile(ww.users, ww.passwordHash,
                    new URL('../user-passwords.json', import.meta.url).pathname);
                ww.config.setDbPurpose('dev');
                console.info(`post-pull complete: ${inserted} users seeded (${skipped} already present), ` +
                             `${pw.set} passwords seeded (${pw.kept} already set), db marked 'dev'`);
            });
            Deno.exit(0);
            break;
        }

        // Import the batch re-categorization (see categorization/ and
        // category-import.ts): seed the category table (new scheme + internal
        // + retired ~old-*) and rewrite every entry's category tuples via
        // applyTransaction.  Idempotent - re-run freely after pulls; entries
        // already in the desired state are skipped.  This is the prototype
        // for the eventual production import, so it refuses a production-
        // marked db unless --allow-production is given.
        //   ./wordwiki.sh import-categories [categorization-dir]
        //                  [--username=NAME] [--allow-production]
        case 'import-categories': {
            const reportValueIx = args.indexOf('--report') + 1;   // 0 when absent
            const dir = args.find((a, i) => i >= 1 && !a.startsWith('--') && i !== reportValueIx)
                ?? new URL('../categorization', import.meta.url).pathname;
            // Stamped with the reserved automation identity by default
            // (history UI collapses '~' authors; restore refuses to cross
            // the migration) - --username=NAME for a human-attributed run.
            const username = args.find(a => a.startsWith('--username='))?.slice('--username='.length)
                ?? '~category-import';
            const step = stepReport('Import categories');
            try {
                security.runSystem(() => {
                    ww.ensureNewStyleTables();
                    if(ww.config.getDbPurpose() === 'production' && !args.includes('--allow-production'))
                        throw new Error("db is marked db_purpose='production' - " +
                                        'run with --allow-production if you really mean it');
                    user.seedUsersFromEntrySchema(ww.users);   // the system users ride along post-pull
                    if(!ww.users.byUsername.first({username}))
                        throw new Error(`--username '${username}' is not in the user table`);
                    const schemeText = Deno.readTextFileSync(`${dir}/scheme.md`);
                    const assignmentsText = Deno.readTextFileSync(`${dir}/assignments.jsonl`);
                    const stats = categoryImport.importCategories(ww, {
                        schemeText, assignmentsText, username,
                        log: step.log,
                    });
                    // The idempotency proof for the migration recipe: a re-run
                    // against an already-migrated db must be a pure no-op.
                    if(args.includes('--expect-no-changes')) {
                        const changes = stats.rewrite.entriesRewritten
                            + stats.seed.seededNew + stats.seed.seededInternal + stats.seed.seededOld
                            + stats.mute.valuesRenamed;
                        if(changes > 0)
                            throw new Error(`--expect-no-changes: the import made ${changes} changes - ` +
                                            'the previous run did not reach the fixed point');
                        step.log('idempotency confirmed: re-run made no changes');
                    }
                });
                step.finish();
            } catch(e) { step.crash(e); throw e; }
            Deno.exit(0);
            break;
        }

        // Backfill the twitter-post attribute from the retired legacy Shoebox
        // dump (word-a-day kept being posted there for ~2 years post-retirement;
        // see twitter-post-import.ts).  Matches each legacy lexeme to a current
        // entry by Listuguj spelling and adds a twitter-post to unambiguous
        // matches that lack one; homonyms/unmatched are skipped and logged.
        // Idempotent (re-run adds nothing); refuses production without
        // --allow-production.  Runs BEFORE backfill-publication so the new
        // rows get born-approved.
        //   ./wordwiki.sh import-twitter-posts [legacy-file]
        //                  [--username=NAME] [--allow-production] [--expect-no-changes]
        case 'import-twitter-posts': {
            const reportValueIx = args.indexOf('--report') + 1;   // 0 when absent
            const file = args.find((a, i) => i >= 1 && !a.startsWith('--') && i !== reportValueIx)
                ?? new URL('../legacy-mmo.txt', import.meta.url).pathname;
            const username = args.find(a => a.startsWith('--username='))?.slice('--username='.length)
                ?? twitterPostImport.TWITTER_POST_IMPORT_USER;
            const step = stepReport('Import twitter posts');
            try {
              security.runSystem(() => {
                ww.ensureNewStyleTables();
                if(ww.config.getDbPurpose() === 'production' && !args.includes('--allow-production'))
                    throw new Error("db is marked db_purpose='production' - " +
                                    'run with --allow-production if you really mean it');
                user.seedUsersFromEntrySchema(ww.users);   // the ~ import identities ride along
                if(!ww.users.byUsername.first({username}))
                    throw new Error(`--username '${username}' is not in the user table`);
                const legacyText = Deno.readTextFileSync(file);
                const stats = twitterPostImport.importTwitterPosts(ww, legacyText, {
                    username, log: step.log,
                });
                // --report-skipped=<file>: (re)write the hand-off list of the
                // homonyms/unmatched a human must place in production, with
                // live links to the production editor.  Regenerated every
                // migrate so the committed skipped-twitter-posts.md tracks the
                // shrinking list.
                const reportPath = args.find(a => a.startsWith('--report-skipped='))
                    ?.slice('--report-skipped='.length);
                if(reportPath) {
                    Deno.writeTextFileSync(reportPath, twitterPostImport.renderSkippedReport(stats));
                    step.log(`wrote skipped-post report (${stats.ambiguous + stats.unmatched} entries) to ${reportPath}`);
                }
                if(args.includes('--expect-no-changes')) {
                    if(stats.added > 0)
                        throw new Error(`--expect-no-changes: the import added ${stats.added} twitter-posts`);
                    step.log('idempotency confirmed: re-run made no changes');
                }
              });
              step.finish();
            } catch(e) { step.crash(e); throw e; }
            Deno.exit(0);
            break;
        }

        // Read-only post-migration sanity checks (see migration-verify.ts);
        // exit 1 on violated invariants.  [dir] supplies scheme.md for the
        // exact scheme-vs-table check (defaults like import-categories).
        // Idempotent structural repairs of the assertion store (repair-
        // assertions.ts): fixes corruption surfaced by verify-workspace -
        // currently dangling chain heads. A no-op on a clean db, so it rides
        // in the repeatable migration flow (importWordWikiV1Db.sh). Refuses a
        // production db without --allow-production, like the imports.
        case 'repair-assertions': {
            const step = stepReport('Repair assertions');
            try {
                security.runSystem(() => {
                    ww.ensureNewStyleTables();
                    if(ww.config.getDbPurpose() === 'production' && !args.includes('--allow-production'))
                        throw new Error("db is marked db_purpose='production' - " +
                                        'run with --allow-production if you really mean it');
                    const stats = repairAssertions({log: step.log});
                    step.log(`repair-assertions: ${stats.danglingChainHeadsFixed} dangling chain head(s) fixed, ` +
                             `${stats.legacyPublishedPlaceholdersCleared} legacy published placeholder row(s) cleared, ` +
                             `${stats.orphanedChildrenTombstoned} orphaned live child(ren) tombstoned`);
                });
                step.finish();
            } catch(e) { step.crash(e); throw e; }
            Deno.exit(0);
            break;
        }

        // Phase 0 of the publication model (publication-backfill.ts): born-approve
        // the existing accepted state - the current live fact of every chain,
        // whatever its entry's status (the cutover blesses the whole offline-
        // approved dictionary) - by mute-in-place (no approval rows). Idempotent;
        // refuses production without --allow-production. --expect-no-changes
        // proves a re-run is a no-op.
        case 'backfill-publication': {
            const step = stepReport('Publication backfill (Phase 0)');
            try {
                security.runSystem(() => {
                    ww.ensureNewStyleTables();
                    if(ww.config.getDbPurpose() === 'production' && !args.includes('--allow-production'))
                        throw new Error("db is marked db_purpose='production' - " +
                                        'run with --allow-production if you really mean it');
                    const stats = backfillPublication({log: step.log, config: ww.config});
                    if(args.includes('--expect-no-changes')) {
                        if(stats.bornApproved > 0)
                            throw new Error(`--expect-no-changes: the backfill born-approved ${stats.bornApproved} facts`);
                        step.log('idempotency confirmed: re-run made no changes');
                    }
                });
                step.finish();
            } catch(e) { step.crash(e); throw e; }
            Deno.exit(0);
            break;
        }

        // Normalize the legacy shoebox-date attribute values to ISO yyyy-mm-dd
        // (creation-dates.ts): the imported lexemes' creation dates, made
        // machine-readable in place (mute-in-place like the backfill - no new
        // assertion rows; superseded versions keep their original text).
        // Idempotent; refuses production without --allow-production.
        // --expect-no-changes proves a re-run is a no-op.
        case 'normalize-shoebox-dates': {
            const step = stepReport('Normalize shoebox dates');
            try {
                security.runSystem(() => {
                    ww.ensureNewStyleTables();
                    if(ww.config.getDbPurpose() === 'production' && !args.includes('--allow-production'))
                        throw new Error("db is marked db_purpose='production' - " +
                                        'run with --allow-production if you really mean it');
                    const stats = normalizeShoeboxDates({log: step.log});
                    if(args.includes('--expect-no-changes')) {
                        if(stats.normalized > 0)
                            throw new Error(`--expect-no-changes: normalized ${stats.normalized} shoebox dates`);
                        step.log('idempotency confirmed: re-run made no changes');
                    }
                });
                step.finish();
            } catch(e) { step.crash(e); throw e; }
            Deno.exit(0);
            break;
        }

        // Structural validation of the persisted versioned model (read-only):
        // load the whole dict into the workspace and run the invariant sweep
        // (versioned-db-validate.ts). Exit 1 on any problem.
        // The variant (orthography) invariants run too, but in WARN MODE:
        // pre-migration data violates them wholesale, so they are aggregated
        // as warnings and do not affect the exit code until the orthography
        // migration lands (fix-orthographies.md).
        case 'verify-workspace': {
            const step = stepReport('Verify workspace (structural invariants)');
            let problemCount = 0;
            try {
                const {problems, variantWarnings} = security.runSystem(() => {
                    ww.ensureNewStyleTables();
                    const facts = factViewsFromVersionedDb(ww.workspace);
                    return {
                        problems: validateVersionedDb(ww.workspace),
                        variantWarnings: validateVariantInvariants(
                            facts, variantPolicyByTag(ww.dictSchema),
                            orthography.orthographyVocabulary(ww.orthographies)),
                    };
                });
                problemCount = problems.length;
                if(problems.length > 0) {
                    const sect = step.report.section('STRUCTURAL PROBLEMS');
                    for(const p of problems)
                        sect.finding(`[${p.invariant}] ${p.path}: ${p.detail}`);
                }
                // Aggregate the (numerous, expected) variant warnings per
                // invariant+tag, with a few sample paths each.
                const groups = new Map<string, {n: number, samples: string[]}>();
                for(const w of variantWarnings) {
                    const tag = w.path.split('/').pop()?.split(':')[0] ?? '?';
                    const key = `${w.invariant} on ${entry.relationDisplayName(tag)}`;
                    const g = groups.get(key) ?? {n: 0, samples: []};
                    g.n++;
                    if(g.samples.length < 3) g.samples.push(w.path);
                    groups.set(key, g);
                }
                for(const [key, g] of groups)
                    step.log(`WARNING [${key}] ×${g.n} - e.g. ${g.samples.join(', ')}`);
                step.log(`verify-workspace: ${problems.length} problem(s), ` +
                         `${variantWarnings.length} variant warning(s) (warn mode)`);
                step.finish();
            } catch(e) { step.crash(e); throw e; }
            Deno.exit(problemCount === 0 ? 0 : 1);
            break;
        }

        // Scan current variant (orthography) values against the schema's $
        // flags (fix-orthographies.md "Data scan") - read-only, reported via
        // the findings API.  The $notVariant drop-gate PASS is a precondition
        // the orthography migration re-checks at run time; the dirt findings
        // (blank backfill workload, off-vocabulary values, ...) do not fail
        // the scan.  Exit 0 iff the gate passes.
        //   ./wordwiki.sh scan-variants [--report import-report/scan-variants.md]
        case 'scan-variants': {
            const reportIx = args.indexOf('--report');
            const reportPath = reportIx >= 0 ? args[reportIx + 1] : undefined;
            const gatePassed = security.runSystem(() => {
                ww.ensureNewStyleTables();
                const sourceDb = `${(()=>{try{return Deno.realPathSync('database/db.db');}catch{return 'database/db.db';}})()} [db_purpose: ${ww.getDbPurpose() ?? 'unmarked'}]`;
                const report = new FindingsReport('Variant (orthography) scan', {sourceDb});
                const result = scanVariants(report, ww.dictSchema,
                    orthography.orthographyVocabulary(ww.orthographies));
                if(reportPath) {
                    Deno.writeTextFileSync(reportPath, report.toMarkdown());
                    console.info(`wrote ${reportPath}`);
                }
                console.info(`scan-variants: ${report.findingCount} finding(s); ` +
                             `drop gate ${result.gatePassed ? 'PASS' : 'FAIL'}`);
                return result.gatePassed;
            });
            Deno.exit(gatePassed ? 0 : 1);
            break;
        }

        // THE variant (orthography) data migration - fix-orthographies.md
        // "Migration mechanics".  Mute-in-place on current rows, idempotent,
        // preconditions re-checked at run time (flagged schema, drop gate,
        // mapping coverage - see variant-migrate.ts, incl. the per-tag blank
        // backfill + value-fix DECISION TABLES).  Hand-triage rows are left
        // for the live cleanup report (wordwiki.variantReports.cleanupReport()).
        //   ./wordwiki.sh migrate-variants [--report path.md]
        //   ./wordwiki.sh migrate-variants --expect-no-changes    # idempotency proof
        //   ./wordwiki.sh migrate-variants --dry-run --report r.md  # REVIEW: report
        //       every case (decision evidence, value fixes enumerated, backfill
        //       samples) without writing; with --expect-no-changes it is a
        //       read-only "is this db fully migrated?" probe
        case 'migrate-variants': {
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                const dryRun = args.includes('--dry-run');
                if(!dryRun && ww.config.getDbPurpose() === 'production' && !args.includes('--allow-production'))
                    throw new Error("db is marked db_purpose='production' - " +
                                    'run with --allow-production if you really mean it');
                const reportPath = reportPathArg();
                const sourceDb = `${(()=>{try{return Deno.realPathSync('database/db.db');}catch{return 'database/db.db';}})()} [db_purpose: ${ww.getDbPurpose() ?? 'unmarked'}]`;
                const report = new FindingsReport(
                    `Variant (orthography) migration${dryRun ? ' — DRY RUN' : ''}`, {sourceDb});
                const stats = migrateVariants(report, ww.dictSchema,
                                              orthography.orthographyVocabulary(ww.orthographies),
                                              {dryRun});
                if(reportPath) {
                    Deno.writeTextFileSync(reportPath, report.toMarkdown());
                    console.info(`wrote ${reportPath}`);
                }
                if(args.includes('--expect-no-changes')) {
                    if(stats.changed > 0)
                        throw new Error(`--expect-no-changes: ${dryRun ? 'would change' : 'changed'} ` +
                                        `${stats.changed} variant row(s)`);
                    console.info(dryRun ? 'read-only probe: the db is fully migrated'
                                        : 'idempotency confirmed: re-run made no changes');
                }
                console.info(`migrate-variants: ${stats.changed} row(s) ${dryRun ? 'WOULD change (dry run)' : 'changed'} ` +
                             `(${Object.entries(stats.byAction).map(([a, n]) => `${a} ${n}`).join(', ') || 'nothing to do'})`);
            });
            Deno.exit(0);
            break;
        }

        // Export the transliteration ORACLE: every clean human-written
        // Listuguj/Smith-Francis sibling pair, as JSON for the standalone
        // rules-iteration harness (wordwiki/transliterate-harness.ts).
        // Junky pairs are EXCLUDED AND NAMED (never silently).
        //   ./wordwiki.sh export-transliteration-pairs [path.json]
        case 'export-transliteration-pairs': {
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                const path = args[1] && !args[1].startsWith('--') ? args[1]
                    : 'transliteration-pairs.json';
                const {pairs} = ww.transliterationReports.corpusPairs();
                const clean: typeof pairs = [];
                const excluded = new Map<string, number>();
                for(const p of pairs) {
                    const reason = pairJunkReason(p.li, p.sf, p.tag);
                    if(reason) excluded.set(reason, (excluded.get(reason) ?? 0) + 1);
                    else clean.push(p);
                }
                Deno.writeTextFileSync(path, JSON.stringify(clean, null, 1));
                console.info(`wrote ${clean.length} clean pairs to ${path}`);
                for(const [reason, n] of excluded)
                    console.info(`  excluded ×${n}: ${reason}`);
            });
            Deno.exit(0);
            break;
        }

        // Dump the PUBLISH SOURCE: the reduced, simplified projection the
        // public-site generator consumes, as ONE versioned JSON bundle (doc
        // of record: wordwiki/publish-source.md).  This is the stage-3
        // ARCHIVAL artifact - neutral-format data meant to outlive the
        // software - and it cannot rot, because the live publish is driven
        // off the same bundle.  generatedAt is stamped HERE only, so the
        // bundle itself stays deterministic/diffable when built in memory.
        //   ./wordwiki.sh dump-publish-source [path.json]
        case 'dump-publish-source': {
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                const path = args[1] && !args[1].startsWith('--') ? args[1]
                    : 'publish-source.json';
                const source = buildPublishSource(ww);
                Deno.writeTextFileSync(path, JSON.stringify(
                    {...source, generatedAt: new Date().toISOString()}, null, 1));
                console.info(`wrote publish source to ${path}: ` +
                             `${source.entries.length} entries, ` +
                             `${source.categories.length} categories, ` +
                             `${source.users.length} users, ` +
                             `${source.books.length} books ` +
                             `[orthography: ${source.orthography}, db_purpose: ${source.dbPurpose}]`);
            });
            Deno.exit(0);
            break;
        }

        // Assemble the per-step import-report fragments into ONE
        // import-report.md with an executive summary (fix-orthographies.md
        // "Findings publish path").  Run by importWordWikiV1Db.sh via a
        // shell trap, so it happens EVEN WHEN A STEP CRASHES - a crash
        // mid-migration is exactly when the report matters most.  Expected
        // step names (beyond the fragments present) are listed as MISSING.
        //   ./wordwiki.sh assemble-import-report <fragmentDir> <out.md> [expected...]
        case 'assemble-import-report': {
            const dir = args[1] ?? 'import-report';
            const outPath = args[2] ?? 'import-report.md';
            const expected = args.slice(3);
            const fragments: {name: string, content: string}[] = [];
            try {
                const names = [...Deno.readDirSync(dir)]
                    .filter(e => e.isFile && /^[0-9]+-[a-z0-9-]+\.md$/.test(e.name))
                    .map(e => e.name).sort();
                for(const name of names)
                    fragments.push({name, content: Deno.readTextFileSync(`${dir}/${name}`)});
            } catch(_e) { /* no fragment dir: assemble the empty story */ }
            Deno.writeTextFileSync(outPath, assembleImportReport(fragments, expected));
            console.info(`assembled ${fragments.length} fragment(s) into ${outPath}`);
            Deno.exit(0);
            break;
        }

        // The STATUS REMODEL data migration (fix-orthographies.md "Status",
        // status-migrate.ts): publish gates from Completed statuses, the
        // lifecycle renames, sta variant blanking, and lifecycle synthesis
        // for no-status entries.  ONCE PER DB (config marker), dry-runnable.
        // Runs BEFORE migrate-variants in the pipeline (it reads sta variants
        // for the gate orthography, then blanks them).
        //   ./wordwiki.sh migrate-status [--dry-run] [--report path.md] [--expect-no-changes]
        case 'migrate-status': {
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                const dryRun = args.includes('--dry-run');
                if(!dryRun && ww.config.getDbPurpose() === 'production' && !args.includes('--allow-production'))
                    throw new Error("db is marked db_purpose='production' - " +
                                    'run with --allow-production if you really mean it');
                const reportPath = reportPathArg();
                const sourceDb = `${(()=>{try{return Deno.realPathSync('database/db.db');}catch{return 'database/db.db';}})()} [db_purpose: ${ww.getDbPurpose() ?? 'unmarked'}]`;
                const report = new FindingsReport(
                    `Status remodel migration${dryRun ? ' — DRY RUN' : ''}`, {sourceDb});
                const stats = migrateStatus(report, {dryRun, config: ww.config});
                if(reportPath) {
                    Deno.writeTextFileSync(reportPath, report.toMarkdown());
                    console.info(`wrote ${reportPath}`);
                }
                if(args.includes('--expect-no-changes')) {
                    if(stats.changed > 0)
                        throw new Error(`--expect-no-changes: ${dryRun ? 'would change' : 'changed'} ` +
                                        `${stats.changed} row(s)`);
                    console.info(dryRun ? 'read-only probe: the status remodel is done on this db'
                                        : 'idempotency confirmed: re-run made no changes');
                }
                console.info(`migrate-status: ${stats.changed} change(s) ` +
                             `(${Object.entries(stats.byAction).map(([a, n]) => `${a} ${n}`).join(', ') || 'nothing to do'})`);
            });
            Deno.exit(0);
            break;
        }

        case 'verify-migration': {
            const reportValueIx = args.indexOf('--report') + 1;   // 0 when absent
            const dir = args.find((a, i) => i >= 1 && !a.startsWith('--') && i !== reportValueIx)
                ?? new URL('../categorization', import.meta.url).pathname;
            const schemeText = (() => {
                try { return Deno.readTextFileSync(`${dir}/scheme.md`); }
                catch (_e) { return undefined; }
            })();
            const step = stepReport('Verify migration');
            let ok = false;
            try {
                ok = security.runSystem(() => {
                    ww.ensureNewStyleTables();
                    const vr = migrationVerify.verifyMigration(ww, {schemeText});
                    for(const m of vr.info) step.log(m);
                    if(vr.warnings.length > 0) {
                        const w = step.report.section('Warnings');
                        for(const m of vr.warnings) w.finding(m);
                    }
                    if(vr.failures.length > 0) {
                        const f = step.report.section('FAILURES');
                        for(const m of vr.failures) f.finding(m);
                    }
                    step.log(`verify-migration: ${vr.failures.length} failures, ` +
                             `${vr.warnings.length} warnings`);
                    return vr.failures.length === 0;
                });
                step.finish();
            } catch(e) { step.crash(e); throw e; }
            Deno.exit(ok ? 0 : 1);
            break;
        }

        // Publish from the CLI - the whole site, or just the named targets
        // for quick turnaround while iterating on templates.  Targets are
        // site-relative paths ("the URL you want rebuilt" - see
        // parsePublishTarget in publish.ts for the grammar); errors and
        // warnings go to stdout and a non-zero exit means errors.
        // Publishing only READS the db, so wordwiki.sh leaves the dev
        // server running for this command.
        //   ./wordwiki.sh publish                                 # everything
        //   ./wordwiki.sh publish entries/samqwan categories/water
        //   ./wordwiki.sh publish --root=/tmp/staging categories    # other tree
        case 'publish': {
            const targets = args.slice(1).filter(a => !a.startsWith('--'));
            const root = args.find(a => a.startsWith('--root='))?.slice('--root='.length) || '.';
            const exitCode = await security.runSystem(async () => {
                ww.ensureNewStyleTables();
                const status = new publish.PublishStatus();
                status.start();
                const pub = new publish.Publish(status, buildPublishSource(ww), root);
                if(root !== '.')
                    await Deno.mkdir(root, {recursive: true});
                try {
                    if(targets.length === 0)
                        await pub.publish();
                    else
                        await pub.publishTargets(targets);
                } catch(e) {
                    status.errors.push(String(e instanceof Error ? (e.stack ?? e.message) : e));
                }
                status.end();
                for(const w of status.warnings)
                    console.info(`WARNING: ${publish.publishMessageText(w)}`);
                for(const err of status.errors)
                    console.error(`ERROR: ${publish.publishMessageText(err)}`);
                const secs = Math.round(((status.endTime ?? 0) - (status.startTime ?? 0)) / 1000);
                console.info(`publish${targets.length ? ` of ${targets.join(', ')}` : ''} ` +
                             `completed in ${secs}s: ` +
                             `${status.errors.length} errors, ${status.warnings.length} warnings`);
                return status.errors.length > 0 ? 1 : 0;
            });
            Deno.exit(exitCode);
            break;
        }

        // Import the lexical form (part of speech) vocabulary (see
        // lexical-form-import.ts): seed the curated table, normalize the
        // UNAMBIGUOUS legacy values in the data ('vii ' -> vii, 'particle'
        // -> PTCL) via applyTransaction, and report the remaining un-tabled
        // values as the team's curation worklist.  Idempotent; guarded like
        // import-categories.
        //   ./wordwiki.sh import-lexical-forms [--username=NAME] [--allow-production]
        case 'import-lexical-forms':
        case 'seed-lexical-forms': {   // older name kept as an alias
            // Default stamp = the automation identity (see import-categories).
            const username = args.find(a => a.startsWith('--username='))?.slice('--username='.length)
                ?? '~lexical-form-import';
            const step = stepReport('Import lexical forms');
            try {
                security.runSystem(() => {
                    ww.ensureNewStyleTables();
                    if(ww.config.getDbPurpose() === 'production' && !args.includes('--allow-production'))
                        throw new Error("db is marked db_purpose='production' - " +
                                        'run with --allow-production if you really mean it');
                    user.seedUsersFromEntrySchema(ww.users);   // the system users ride along post-pull
                    if(!ww.users.byUsername.first({username}))
                        throw new Error(`--username '${username}' is not in the user table`);
                    const stats = lexicalFormImport.importLexicalForms(
                        ww, {username, log: step.log});
                    if(args.includes('--expect-no-changes')) {
                        const changes = stats.seeded.inserted + stats.subentriesNormalized;
                        if(changes > 0)
                            throw new Error(`--expect-no-changes: the import made ${changes} changes - ` +
                                            'the previous run did not reach the fixed point');
                        step.log('idempotency confirmed: re-run made no changes');
                    }
                });
                step.finish();
            } catch(e) { step.crash(e); throw e; }
            Deno.exit(0);
            break;
        }

        // Mark the database's purpose (production databases refuse destructive
        // test/dev operations and get Secure cookies).
        case 'set-db-purpose': {
            const purpose = args[1];
            if(purpose !== 'production' && purpose !== 'dev' && purpose !== 'test')
                throw new Error('usage: set-db-purpose production|dev|test');
            security.runSystem(() => {
                ww.ensureNewStyleTables();
                ww.config.setDbPurpose(purpose);
                console.info(`db_purpose set to '${purpose}'`);
            });
            Deno.exit(0);
            break;
        }

        default:
            throw new Error(`incorrect usage: unknown command "${command}"`);
    }
}
