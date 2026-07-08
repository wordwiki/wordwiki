/**
 * THE per-language-community configuration (the de-Mi'kmaq seam of the
 * WordWiki decomposition): the values a NEW language group deploying this
 * software edits, gathered in one dependency-free module instead of being
 * scattered through the code as literals.
 *
 * Code must reference `siteConfig.<field>` (or a constant derived from it,
 * like entry-schema's PUBLIC_SITE_ORTHOGRAPHY) rather than repeating the
 * values.  Data that the DB already knows - the reference books
 * (scanned_document), the orthography vocabulary (orthography table), users
 * - is deliberately NOT duplicated here: derive it from the db.
 *
 * Future: load these from an instance config file / the config table; for
 * now a typed literal keeps it honest and greppable.
 */

export interface SiteConfig {
    /** The editor app's name - the navbar brand and the login card title. */
    editorName: string;
    /** The one-line description under the login title. */
    editorSubtitle: string;
    /** The orthography THE public site is rendered in (also the fallback
     *  working orthography for editors who have not picked one). */
    publicSiteOrthography: string;
    /** Collation locale for source-language sorting (Intl.Collator).
     *  One locale for all orthographies today; can become per-orthography
     *  when a community's orthographies collate differently. */
    collationLocale: string;
    /** The primary source book (a scanned_document friendly_document_id):
     *  the default target of the entries-by-book-page report links. */
    primarySourceBook: string;
}

export const siteConfig: SiteConfig = {
    editorName: 'MMO Editor',
    editorSubtitle: `The Mi'gmaq-Mi'kmaq Online dictionary editor`,
    publicSiteOrthography: 'mm-li',
    collationLocale: 'en',
    primarySourceBook: 'PDM',
};
