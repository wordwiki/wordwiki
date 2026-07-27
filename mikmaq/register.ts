/**
 * Boot-time registration of the Mi'gmaq specializations into the general
 * wordwiki engines (dz's packaging rule): imported for its side effects
 * by the BINARY EDGE (cli.ts) and by tests that want Mi'gmaq behavior -
 * never by general modules.
 */
import { registerOrthoNormalizers } from '../wordwiki/similarity.ts';
import { registerLanguageRules } from '../wordwiki/similarity-rules.ts';
import { MIKMAQ_NORMALIZERS, MIKMAQ_RULES } from './language.ts';

registerOrthoNormalizers(MIKMAQ_NORMALIZERS);
registerLanguageRules(MIKMAQ_RULES);
