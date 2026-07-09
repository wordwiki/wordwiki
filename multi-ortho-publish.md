Multi ortho publish proposal:

First some details:

The published site is presently primarily published on the web, where we can do complicated mappings with caddy etc, BUT
we have two longevity goals:

- rsync only mirror - someone should be able to RSYNC the public site somewhere, and it should be fully operable without
  having to reproduce any mappings in a web server etc.
- furthermore, the site should be fully operable if it is put on a USB stick and run via file:// URL (this is why, for
  example the search is implemented in page).
  
This means that our multi-otography scheme must not use mappings.

Furthermore, we don't want to just have each site be fully independent - 99% of the site data (by bytes) is
shared (the recordings and images in the content adressable stores) - so we need the two sites to share
a content directory.

So this leads to a proposed structure of (relative to publish root):

/sf/index.html
/li/index.html which has a link to ../content/823174293/823174231.mp3
/content/...

(note all links are always relative to allow for the USB stick model) - this is why the site is littered with sometimes
complicated ../../.. computations rather than absolute refs).

In the specific case of the Mi'gmaq language (and this will not be true for all languages) the language name is spelled
differently in the two orthographies.  The complication is that the founders of the presently LI spelled dictionary
used the SF spelling for the domain name (mi'gmaq is LI, mi'kmaq is SF).  The obvious choice of registering the LI
spelling of the domain name and only serving LI content from there is not great - there are links all over the web
that will break.  So I think this dictionary will continue to run off the one domain name.

So the proposal is:
- fulling working dictionary in /li AND in /sf, using ../ to access shared content and resources directories.
- this must be fully working from a USB stick, generic config web server etc.

THEN as a next step:
- we need to setup forwarding for ALL paths as of the cutover date (and for ease, may just maintain them in the future)
- there is already code in publish that writes entry forwarders for all the lexeme paths served by the predicessor system
  (mostly in the servlet directory) - see publishEntryForwarder.  This is using http-equiv refresh rather than a caddy
  301).  I suspect the better move our new URL transition would be to generate the list of directives I can #include in my caddy file
  (possibly using regex based rename rules for evertying not in the top level) that will do this.
- with this in place access to any existing URL will 301 to the new /li version.
- the forward from the home to the /li version included (possbily set manually).
- swithhing between the two versions of any item (home page, word etc will just be a link into the peer version (with lots of ../..).
  (so on the LI home page (li/index.html), clicking on SF will navigatte to ../sf/index.html) 

This scheme is intended to work for future dictionaries other than MM.

Publish should probably continue to publish all orthos - with all the approved etc gating - publish is just an artifact of
not having a fully live system (to get the benifit of static site) - not a major user decision.


---

## Status (2026-07-09): BUILT

One run, all publishable orthographies (`./wordwiki.sh publish`):

- A full tree per orthography (`/li/...`, `/sf/...`) sharing the root
  `content/` `derived/` `resources/` `scripts/` stores via `../`; path
  segments come from the orthography TABLE's abbreviations (data, not
  code).  VERIFIED file:// operable: a link checker resolves every
  relative href/src in the output (1.81M refs) - which also caught and
  fixed a pre-existing book-page `../` overshoot that web browsers had
  been silently clamping.
- The ROOT `index.html` meta-refreshes straight to the primary tree
  (works from a USB stick / bare mirror), with the static orthography
  CHOOSER as its fallback body; on the web, the GENERATED
  `data/caddy-redirects.conf` (#include it) 301s `/` and every legacy
  top-level path to the primary tree.
- `/servlet` forwarders stay at the ROOT (the internet's old links),
  written by the primary tree, targeting `/li/...`; they render as tree
  pages that sit at the root, so their chrome works.
- Peer-orthography links on every page (the navbar), with the existence
  rule: a word links its peer page only where it is public there (else
  the peer home); ids per tree (samqwan ↔ waqamik style differences
  handled by the shared run's id maps).
- Each tree carries its own `data/publish-source.json`; the
  orthography-neutral `full-history.json` lives once at the root
  `data/`, linked from every tree's data page.
- THE EDITION MODEL (2026-07-09): `orthography.edition` ('full' |
  'preview'; seed li full, sf/mp/pm preview; rides the bundle as
  `edition`, old dumps default 'full') is ONE editorial judgment that
  drives every public consequence of an edition being young.  A
  'preview' edition:
    - carries the preview banner naming/linking the primary edition;
    - elides the whole home search payload (form, search.js, in-page
      term index) - the permanent Browse section (Words by Category /
      All Words, on EVERY edition's home) plus a "full dictionary in
      ⟨primary⟩ spelling" link remain.  Future re-enable story: a
      smart search empty-state ("no SF results - N matches in
      Listuguj") once the edition is big enough to search;
    - publishes NO book sections (Pacifique Manuscript, Reference
      Books): its lane has almost no public words for the scan links
      to land on.  Every book link (navbar + dropdown, home welcome,
      about body, entry-page scan references) crosses into the
      primary tree instead, marked quietly ("In the ⟨primary⟩
      edition"); the primary's book pages' peer links fall back to
      the preview home; prune treats the preview tree's books dir as
      must-be-empty (stale pages from before the model go).
  Mechanism: `PublishOptions.primary` (PrimaryRef {segment, name,
  entryCount}, set on non-primary trees) is the ONE struct every
  cross-into-the-primary feature reads.

  THE RULE AGAINST RE-ACCRETION: no new per-feature orthography
  flags.  A public-site behavior either works at any edition size
  (make it presence-filtered, like categories), or it keys off
  `edition` and cross-links via `primary`.  Anything that fits
  neither bucket is a design smell - take it back to dz.
