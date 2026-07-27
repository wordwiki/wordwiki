/**
 * The registered Mi'gmaq transliteration pairs: registry wiring, the
 * li-sf wrap (delegates to the mature engine), and the identity-v0
 * placeholders for the new corpora.
 */
import { test } from "../liminal/testing/test.ts";
import { assert, assertEquals } from "../liminal/testing/assert.ts";
import "./register.ts";
import { transliterationPair, transliterationPairFor,
         transliterationPairIds } from "../wordwiki/transliterate-pair.ts";
import { transliterateLiToSf } from "../wordwiki/transliterate.ts";

test("mikmaq pairs: registration + the li-sf wrap", () => {
    const ids = transliterationPairIds();
    for(const id of ['li-sf', 'wsf-wli', 'wli-mmli'])
        assert(ids.includes(id), `registered: ${id}`);

    const lisf = transliterationPair('li-sf')!;
    assertEquals(lisf.sourceLane, 'mm-li');
    assertEquals(lisf.targetLane, 'mm-sf');
    const word = "mawita'jig";
    assertEquals(lisf.transliterate(word), transliterateLiToSf(word));
    const cands = lisf.candidates!(word, 3);
    assert(cands.length >= 1 && cands.length <= 3, 'ranked candidates');
    assert(lisf.candidateTransliterators!.length >= 1);

    // Lane-based lookup (the editor/report consumers' entry point).
    assertEquals(transliterationPairFor('mm-li', 'mm-sf')?.id, 'li-sf');
    assertEquals(transliterationPairFor('watson-sf', 'watson-li')?.id, 'wsf-wli');

    // The watson pairs carry corpus extractors and an identity baseline
    // candidate alongside the current rules.
    for(const id of ['wsf-wli', 'wli-mmli']) {
        const p = transliterationPair(id)!;
        assert(p.extractCorpus !== undefined, `${id} extractor`);
        assert(p.candidateTransliterators!.some(c => c.name.includes('identity')),
               `${id} identity baseline candidate`);
    }
});

test("mikmaq pairs: the watson rules", () => {
    const wsf = transliterationPair('wsf-wli')!;
    // Voicing, -y→-i, medial echo epenthesis, w-possessive, ln→nn, -sik.
    assertEquals(wsf.transliterate('keknasimkewey'), 'gegnasimgewei');
    assertEquals(wsf.transliterate('apoqnmatiet'), 'apoqonmatiet');
    assertEquals(wsf.transliterate('wtmo\'taqan'), 'ugtmo\'taqan');
    assertEquals(wsf.transliterate('lnuiasunaq'), 'nnuiasunaq');
    assertEquals(wsf.transliterate('telkisita\'sik'), 'telgisita\'s\'g');
    // Word-final aqn is a measured 50/50 in Watson's writing - v2 leaves it.
    assertEquals(wsf.transliterate('aqnutmaqn'), 'aqnutmaqn');
    // The schwa branch: ' preferred, Watson's backtick as ranked runner-up.
    assertEquals(wsf.transliterate('naqtɨk'), "naqt'g");
    assertEquals(wsf.candidates!('naqtɨk', 4), ["naqt'g", 'naqt`g']);

    const wli = transliterationPair('wli-mmli')!;
    assertEquals(wli.transliterate('weligisg`g'), "weligisg'g");
    assertEquals(wli.transliterate('mimgwaqnei'), 'mimgwaqanei');

    // The HUB composition: sf carries what the li spoke lacks - q
    // survives (never folded to g) and sf vowel-length marks pass
    // through; the sf-side re-encoding still applies.
    const hub = transliterationPair('wsf-mmli')!;
    assertEquals(hub.transliterate("apt'skwa'q"), "apt'sgwa'q");
    assertEquals(hub.transliterate('keknasimkewey'), 'gegnasimgewei');
});
