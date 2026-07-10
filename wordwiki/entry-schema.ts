// deno-lint-ignore-file no-unused-vars, no-explicit-any

//import { DB, PreparedQuery, QueryParameter, QueryParameterSet } from "https://deno.land/x/sqlite/mod.ts";
//import { DbSystem, Db, PreparedQuery } from "./db.ts";
//import {startRpcDbServer} from './rpc-db.ts';

//import * as denoSqliteDb from "./denoSqliteDb.ts";
import * as model from './model.ts';
import { markdownToMarkup } from '../liminal/markdown.ts';
//import * as persistence from './persistence.ts';
import * as utils from "../liminal/utils.ts";
import * as timestamp from '../liminal/timestamp.ts';
//import * as render from './render.tsx';
//import * as templates from './templates.ts';
import ContextMenu from '../liminal/context-menu.js';
import { renderStandaloneGroup, singleBoundingGroupEditorURL, pageEditorURLForBoundingGroup, imageRefDescription } from './render-page-editor.ts'; // REMOVE_FOR_WEB
import * as audio from './audio.ts';  // REMOVE_FOR_WEB
import * as random from '../liminal/random.ts';
import { variantMatches } from './variant-policy.ts';
import { siteConfig } from './site-config.ts';

export const DictTag = 'dct';          // dict
export const EntryTag = 'ent';         // entr
export const StatusTag = 'sta';        // stat
export const SpellingTag = 'spl'       // spel
export const SubentryTag = 'sub';      // sub
export const TodoTag = 'tdo';          // todo
export const NoteTag = 'nte';          // note
export const LogTag = 'log';           // log
export const TranslationTag = 'tra';   // tran
export const DefinitionTag = 'def';    // def
export const GlossTag = 'gls';         // glos
export const ExampleTag = 'exa';       // exam
export const ExampleTextTag = 'etx';   // extx
export const ExampleTranslationTag = 'etr'; // extr
export const ExampleRecordingTag = 'erc';   // exrc
export const PronunciationGuideTag = 'prn'; // pron
export const CategoryTag = 'cat';           // cat
export const RelatedEntryTag = 'rel';       // rel
export const AlternateGrammaticalFormTag = 'alt';  // alt
export const AlternateFormTextTag = 'alx';  // altx
export const OtherRegionalFormTag = 'orf';  // orf
export const PictureTag = 'pic';            // pic
export const AttrTag = 'att';                // attr
export const DocumentReferenceTag = 'ref';   // ref
export const RefTranscriptionTag = 'rtr';    // rftr
export const RefExpandedTranscriptionTag = 'rex';  // rf
export const RefTransliterationTag = 'rtl';
export const RefSourceAsEntryTag = 'rse';
export const RefNormalizedSourceAsEntryTag = 'rne';
export const RefForeignReferenceTag = 'rfr';
export const RefNoteTag = 'rnt';
export const RefPublicNoteTag = 'rnp';
export const SourceTag = 'src';
export const RecordingTag = 'rec';
export const PublicTag = 'pub';

// Full relation names for USER-VIEWABLE content (reports, warnings): never
// show the three-letter tags there (dz: "rnp => RefPublicNote").  Keyed by
// tag because tags are the unique relation identity - relation FIELD names
// are not (entry.note and document_reference.note are both named 'note').
export const relationDisplayNameByTag: Record<string, string> = {
    [DictTag]: 'Dict',
    [EntryTag]: 'Entry',
    [StatusTag]: 'Status',
    [SpellingTag]: 'Spelling',
    [SubentryTag]: 'Subentry',
    [TodoTag]: 'Todo',
    [NoteTag]: 'Note',
    [TranslationTag]: 'Translation',
    [DefinitionTag]: 'Definition',
    [GlossTag]: 'Gloss',
    [ExampleTag]: 'Example',
    [ExampleTextTag]: 'ExampleText',
    [ExampleTranslationTag]: 'ExampleTranslation',
    [ExampleRecordingTag]: 'ExampleRecording',
    [PronunciationGuideTag]: 'PronunciationGuide',
    [CategoryTag]: 'Category',
    [RelatedEntryTag]: 'RelatedEntry',
    [AlternateGrammaticalFormTag]: 'AlternateGrammaticalForm',
    [AlternateFormTextTag]: 'AlternateFormText',
    [OtherRegionalFormTag]: 'OtherRegionalForm',
    [PictureTag]: 'Picture',
    [AttrTag]: 'Attr',
    [DocumentReferenceTag]: 'DocumentReference',
    [RefTranscriptionTag]: 'RefTranscription',
    [RefExpandedTranscriptionTag]: 'RefExpandedTranscription',
    [RefTransliterationTag]: 'RefTransliteration',
    [RefSourceAsEntryTag]: 'RefSourceAsEntry',
    [RefNormalizedSourceAsEntryTag]: 'RefNormalizedSourceAsEntry',
    [RefForeignReferenceTag]: 'RefForeignReference',
    [RefNoteTag]: 'RefNote',
    [RefPublicNoteTag]: 'RefPublicNote',
    [SourceTag]: 'Source',
    [RecordingTag]: 'Recording',
    [PublicTag]: 'Public',
};

/** The user-viewable name of a relation tag (falls back to the raw tag for
 *  anything unknown, e.g. a db tag missing from the schema). */
export function relationDisplayName(tag: string): string {
    return relationDisplayNameByTag[tag] ?? tag;
}

// XXX HACK HACK
export const users: Record<string, string> = {
    '___': 'No User Selected',
    'djb': 'Dolly Barnaby',
    'dmm': 'Diane Mitchell',
    'ecm': 'Emma Metallic',
    'ewm': 'Eunice Metallic',
    'gml': 'Gmarie Laroque',
    'jnw': 'Joe Wilmot',
    'kam': 'Karen Martin',
    'kjd': 'Kirsten (Eskasoni)',
    'mch': 'Michel (Listuguj)',
    'mjp': 'Josephine (Wagmatcook)',
    'mmm': 'Maddie Metallic',
    'mmo': 'MMO Team',
    'pjw': 'Pernell Wysote',
    'rem': 'Roger Metallic',
    'rjs': 'Ronald Joseph Swasson',
    'yli': 'Yasmine Isaac',
    'djz': 'David Ziegler',
};

// XXX MORE HACK
export function canUserPublish(userId: string): boolean {
    return userId === 'djz' || userId === 'dmm';
}

// The lexeme LIFECYCLE (fix-orthographies.md "Status" - the status remodel):
// whole-lexeme, exactly one current fact, and deliberately says NOTHING about
// publicness - the per-orthography `pub` gate carries that (entryIsPublicIn).
// 'Completed' renamed to 'Complete' to break the old "complete = public"
// reading (migrate-status renames the data; a not-yet-migrated value renders
// raw).  'Unknown' also absorbs the synthesized lifecycle of entries that had
// no status fact at all.
export const states: Record<string, string> = {
    'Unknown': 'Unknown Status',
    'Complete': 'Complete',
    'CompleteAsPDMOnly': 'Complete As PDM Only',
    'InProcess': 'In Process',
    'InProcessPDMOnly': 'In Process - For PDM Only',
    'OnHold': 'On Hold - To Be Processed',
    'Archived': 'Archived',
    'ArchivedIncomplete': 'Archived - Incomplete',
    'ArchivedNotAWord': 'Archived - Not A Word',
    'ArchivedDuplicate': 'Archived - Duplicate',
};

/**
 * Archival is our DELETE (e.g. a duplicate word is resolved by archiving one
 * side), so features treat archived entries specially: they are excluded
 * from duplicate-spelling detection (spelling-duplicates.ts) and marked
 * ARCHIVED in the internal presentation text (see
 * renderEntryCompactSummaryCore / renderEntryTitle).  The NAMING CONVENTION
 * IS LOAD-BEARING: every archived status slug starts with 'Archived', so a
 * new archived variant joins the special-casing automatically - name it
 * accordingly (and don't name a non-archival status 'Archived*').
 */
export function isArchivedStatus(statusSlug: string): boolean {
    return statusSlug.startsWith('Archived');
}

/** Whether the entry carries ANY current archived status (an entry oddly
 *  holding both an archived and a live status row counts as archived). */
export function isArchivedEntry(e: Entry): boolean {
    return e.status.some(s => isArchivedStatus(s.status));
}

export const todos: Record<string, string> = {
    'Todo': 'Todo',
    'NeedsResearchGroupReview': 'Needs Research Group Review',
    'NeedsSpeakerGroupReview': 'Needs Speaker Group Review',
    'NeedsRecording': 'Needs Recording',
    'NeedsApproval': 'Needs Approval',
};

export const variants: Record<string, string> = {
    'mm-li': 'Listuguj',
    'mm-sf': 'Smith-Francis',
    'mm-mp': 'Modified Pacifique',
    'mm-pm': 'Pacifique Manuscript',
    'mm': "All Mig'maq-Mi'kmaq",
};

// Part-of-speech code -> display name.  Attached to the part_of_speech field as
// $options so the metadata renderer can show the friendly name from DATA rather
// than a hand-coded lookup (the field stays a 'string', so the editor - which
// only consults $options for enum fields - is unchanged).
export const partsOfSpeech: Record<string, string> = {
    "na": "noun animate",
    "ni": "noun inanimate",
    "vii": "verb inanimate intransitive",
    "vai": "verb animate intransitive",
    "vit": "verb inanimate transitive",
    "vat": "verb animate transitive",
    "PTCL": "particle",
    "PCTL": "particle",
    "adv": "adverb",
    "n": "noun",
    "pn": "pronoun",
    "pna": "pronoun animate",
    "pni": "pronoun inanimate",
    "unclassified": "unclassified part of speech",
};

// Grammatical-form code -> display name.  Attached to the grammatical_form
// field as $options so the metadata renderer composes the friendly name from
// DATA (moved up from below so the schema literal can reference it).
export const GrammaticalFormDescriptions: Record<string,string> = {
    "d": "dual",
    "p": "plural",
    "4n": "fourth person",
    "loc": "locative",
    "tem": "temporal",
    "1": "first person singular animate",
    "1d": "first person dual exclusive animate",
    "1p": "first person plural exclusive animate",
    "3id": "third person dual inanimate",
    "3ip": "third person plural inanimate",
    "1-3i": "first person singular animate subject, third person singular inanimate object",
    "1d-3i": "first person dual exclusive animate subject, third person singular inanimate object",
    "1p-3i": "first person plural exclusive animate subject, third person singular inanimate object",
    "3-3ip": "third person singular animate subject, third person plural inanimate object",
    "1-3": "first person singular animate subject, third person singular animate object",
    "1-3p": "first person singular animate subject, third person plural animate object",
    "1-2": "first person singular animate subject, second person singular animate object",
    "3-1": "third person singular animate subject, first person singular animate object",
    "1s-1s": "first person singular reflexive",
    "1d-1d": "first person dual reflexive",
    "1p-1p": "first person plural reflexive",
    "1dr-1d": "first person exclusive dual reciprocal",
    "1pr-1p": "first person exclusive plural reciprocal",
    "3pr-3p": "third person plural reciprocal",

    "3d": "third person dual animate",
    "3p": "third person plural animate",
    "imp": "imperative",
    "ani": "animate",
    "inan": "inanimate",

    "1-3ip": "first person singular animate subject, third person plural inanimate object",
    "s": "singular",
    "n": "noun",
    "pn": "pronoun"
};

export const dictSchemaJson = {
    $type: 'schema',
    $name: 'dict',
    $tag: DictTag,

    entry: {
        $type: 'relation',
        $tag: EntryTag,
        $prompt: 'Entry',
        entry_id: {$type: 'primary_key'},
        $style: { $shape: 'containerRelation' },
        spelling: {
            $type: 'relation',
            $tag: SpellingTag,
            //$style: { $prompt: 'SPELLING!' },
            spelling_id: {$type: 'primary_key'},
            text: {$type: 'string', $bind: 'attr1'},
            variant: {$type: 'variant'},
            // The headword: pulled into the document title, joined ' / ', not
            // repeated in the body.
            // label: the EDIT body shows the spelling section (read keeps
            // it title-only), so its rows need their name.
            $style: { $shape: 'compactInlineListRelation',
                      $view: { order: 1, titleRole: 'headword', join: ' / ', label: 'inline' } },
        },

        status: {
            $type: 'relation',
            $tag: StatusTag,
            //$style: { $prompt: 'SPELLING!' },
            status_id: {$type: 'primary_key'},
            status: {$type: 'enum', $bind: 'attr1', $style: { $options: states} },
            details: {$type: 'string', $bind: 'attr2' },
            // NO variant: the lifecycle is whole-lexeme (status remodel -
            // nobody archives per orthography); publicness forks per
            // orthography in the `pub` relation below instead.
            // Editorial: not in the read view; the EDITOR shows it.
            $style: { $shape: 'compactInlineListRelation',
                      $view: { hidden: true, label: 'inline' } },
        },

        // The per-orthography PUBLISH GATE (fix-orthographies.md "Status"):
        // one fact per orthography; the fact's PRESENCE is the gate - who/
        // when/why come free from the assertion columns.  Managed by the
        // makePublic/withdraw verbs (born-published, approve-gated), rendered
        // as the editor's custom Public row - NOT the generic tuple editor
        // (the renderer omits it; see LexemeEditor).
        public: {
            $type: 'relation',
            $tag: PublicTag,
            $prompt: 'Public',
            public_id: {$type: 'primary_key'},
            variant: {$type: 'variant', $metaVariant: true},
            $style: { $shape: 'compactInlineListRelation',
                      $view: { hidden: true, label: 'inline' } },
        },

        todo: {
            $type: 'relation',
            $tag: TodoTag,
            todo_id: {$type: 'primary_key'},
            todo: {$type: 'enum', $bind: 'attr1',
                   $style: { $options: todos}},
            details: {$type: 'string', $bind: 'attr2', $style: { $width: 30 }},
            assigned_to: {$type: 'enum', $bind: 'attr3', $style: {$options: users}},
            done: {$type: 'boolean', $bind: 'attr4'},
            variant: {$type: 'variant', $metaVariant: true, $allowAll: true, $defaultAll: true},
            // audience internal: editorial workflow - stripped from the
            // public bundle (publish-source stripInternalRelations).
            $style: { $shape: 'compactInlineListRelation',
                      $view: { hidden: true, label: 'inline', audience: 'internal' } },
        },

        note: {
            $type: 'relation',
            $tag: NoteTag,
            note_id: {$type: 'primary_key'},
            note: {$type: 'string', $bind: 'attr1', $style: { $width: 80, $height: 5, $markdown: true }},
            // The EDITORIAL note ("not the public one" - dz); audience
            // internal keeps it out of the public bundle too.
            $style: { $shape: 'compactInlineListRelation',
                      $view: { hidden: true, label: 'inline', audience: 'internal' } },
        },

        subentry: {
            $type: 'relation',
            $tag: SubentryTag,
            subentry_id: {$type: 'primary_key'},
            // A string (editor stays a text box); $options gives the metadata
            // renderer the code -> display name, so the friendly text comes
            // from DATA, not a hand-coded lookup.
            part_of_speech: {$type: 'string', $bind: 'attr1',
                             $style: { $options: partsOfSpeech,
                                       $view: { order: 2, label: 'inline' } }},
            // Only a small % of words have >1 sense: for one, drop the "1." level
            // entirely (read); the editor keeps it.  Numbered when there are
            // several (the senses).  Elide when empty.
            $style: { $shape: 'containerRelation',
                      $view: { order: 3, singleton: 'collapse', numbered: true, empty: 'elide' } },
            // probably should have variant here TODO
            // translation TODO

            translation: {
                $type: 'relation',
                $tag: TranslationTag,
                translation_id: {$type: 'primary_key'},
                translation: {$type: 'string', $bind: 'attr1', $style: { $width: 50 }},
                variant: {$type: 'variant', $notVariant: true},
                $style: { $shape: 'compactInlineListRelation',
                          $view: { order: 1, label: 'inline', join: ' / ' } },
            },

            /*definition: {
                $type: 'relation',
                $tag: DefinitionTag,
                definition_id: {$type: 'primary_key'},
                definition: {$type: 'string', $bind: 'attr1', $style: { $width: 50 }},
                variant: {$type: 'variant'},
                $style: { $shape: 'compactInlineListRelation' },
                //variant: {$type: 'string'}
                // same issue as for gloss variant!!!
                // - need two locales for definition - where it is applicable,
                //   and the language of the definition as well.
                // - this is a complication of wanting multiple target langugages
                //   maybe should drop for now (we will need a bit model redo
                //   at some point).
                // - expressive power needed:
                //    - for source languge facts, we can use locale to specify
                //      their applicability.
                //    - target language facts also have a locale (like most facts) BUT
                //      also have a target language and both have to match.
                //    - for most dictionaries, the target can be defaulted (for
                //      example to 'en', - so user does not need to be aware of this).
                // - this is a low confusion item (the hard part is appling to example)
            },*/

            gloss: {
                $type: 'relation',
                $tag: GlossTag,
                gloss_id: {$type: 'primary_key'},
                gloss: {$type: 'string', $bind: 'attr1', $style: { $width: 50 }},
                variant: {$type: 'variant', $notVariant: true},
                //variant: {$type: 'string'} - COMPLICATED
                // the gloss is (for example) in english, but may want to have
                // a different gloss for SF than LI?  How to model?
                // Mirrored into the title (glossInTitle), slash-joined there.
                // In the BODY each gloss is its own "Gloss:" line (no join) -
                // multiple long glosses read as a slash-run otherwise.
                $style: { $shape: 'inlineListRelation',
                          $view: { order: 3, titleRole: 'gloss', label: 'inline' } },
            },

            example: {
                $type: 'relation',
                $tag: ExampleTag,
                example_id: {$type: 'primary_key'},
                // Always a list, even for one (unlike subentry); elide if none.
                $style: { $shape: 'containerRelation',
                          $view: { order: 4, label: 'heading', singleton: 'list', empty: 'elide' } },

                //translation: {$type: 'string', $bind: 'attr1'},
                // Probably move translation into a sub relation (so can have variants)
                // Thiunk about pairings of tranlation and example.

                // Recordings of example sentences have tricky modelling WRT
                // variants as well (for example the simplest models don't allow
                // a recording to be shared by mutiple locales that have a different
                // orthography - which is not OK.

                // Have the same problem with using locale for the translation as we
                // do for gloss - the locale should probably be WRT the source
                // language of the dictionary.

                // Add target_loccale to the top level translatoin, and we are fine.
                // (having one be privledged is a win to prevent drift, and have
                // a more understandable model - can still to NxN pariings).

                example_text: {
                    $type: 'relation',
                    $tag: ExampleTextTag,
                    $prompt: `Text`,
                    example_text_id: {$type: 'primary_key'},
                    example_text: {$type: 'string', $bind: 'attr1', $style: { $width: 70, $height: 5 }},
                    variant: {$type: 'variant'},
                    $style: { $shape: 'compactInlineListRelation',
                              $view: { order: 1, label: 'inline', join: ' / ', empty: 'elide' } },
                },

                example_translation: {
                    $type: 'relation',
                    $tag: ExampleTranslationTag,
                    $prompt: `Translation`,
                    example_translation_id: {$type: 'primary_key'},
                    example_translation: {$type: 'string', $bind: 'attr1',
                                          $style: { $width: 70, $height: 5, $view: { emphasis: 'italic' } }},
                    variant: {$type: 'variant', $notVariant: true},
                    $style: { $shape: 'compactInlineListRelation',
                              $view: { order: 2, label: 'inline', join: ' / ', empty: 'elide' } },
                },

                // Recordings of example sentence need to be pulled out of the
                // varianted examples because often is just spelling difference, or
                // is good enough.

                // Variant needs support for saying things like 'mm/sf' - meaning usable
                // for smith francis, but not ideal.  Easy enough.
                example_recording: {
                    $type: 'relation',
                    $tag: ExampleRecordingTag,
                    $prompt: `Recording`,
                    example_recording_id: {$type: 'primary_key'},
                    recording: {$type: 'audio', $bind: 'attr1'},
                    speaker: {$type: 'enum', $bind: 'attr2', $style: {$options: users}},
                    variant: {$type: 'variant', $notVariant: true},
                    $style: { $shape: 'compactInlineListRelation',
                              $view: { order: 3, label: 'inline', empty: 'elide' } },
                },
            },

            // recording: {
            //     $type: 'subrelation',
            //     speaker: {$type: 'string'},
            //     recording: {$type: 'string'},
            //     variant: {$type: 'string'}
            // },
            pronunciation_guide: {
                $type: 'relation',
                $tag: PronunciationGuideTag,
                pronunciation_guide_id: {$type: 'primary_key'},
                pronunciation_guide: {$type: 'string', $bind: 'attr1'},
                variant: {$type: 'variant', $notVariant: true},
                $style: { $shape: 'compactInlineListRelation',
                          $view: { order: 5, label: 'inline', join: ', ', empty: 'elide' } },
            },

            category: {
                $type: 'relation',
                $tag: CategoryTag,
                category_id: {$type: 'primary_key'},
                // TODO later convert to ref.
                category: {$type: 'string', $bind: 'attr1'},
                // Navigation/editorial metadata, not part of the word display.
                $style: { $shape: 'compactInlineListRelation',
                          $view: { hidden: true, label: 'inline' } },
            },

            related_entry: {
                $type: 'relation',
                $tag: RelatedEntryTag,
                related_entry_id: {$type: 'primary_key'},
                unresolved_text: {$type: 'string', $bind: 'attr1'},
                $style: { $shape: 'inlineListRelation',
                          $view: { order: 6, label: 'inline', join: ', ', empty: 'elide' } },
            },

            // Probably same variant treatment here as we are doing for examples
            alternate_grammatical_form: {
                $type: 'relation',
                $tag: 'alt',
                alternate_grammatical_form_id: {$type: 'primary_key'},
                // grammatical_form -> friendly name (from data), in parens.
                // The scalar labels only show in EDIT mode (read renders
                // the compose, where labels don't apply).
                grammatical_form: {$type: 'string', $bind: 'attr1',
                                   $style: { $options: GrammaticalFormDescriptions,
                                             $view: { wrap: ['(', ')'], label: 'inline' } }},
                gloss: {$type: 'string', $bind: 'attr2', $style: { $view: { emphasis: 'italic', label: 'inline' } }},
                // Each form reads as one phrase: "form — gloss — (plural)".
                $style: { $shape: 'containerRelation',
                          $view: { order: 7, label: 'heading', empty: 'elide',
                                   compose: ['alternate_form_text', 'gloss', 'grammatical_form'],
                                   sep: ' — ' } },

                alternate_form_text: {
                    $type: 'relation',
                    $tag: AlternateFormTextTag,
                    alternate_form_text_id: {$type: 'primary_key'},
                    alternate_form_text: {$type: 'string', $bind: 'attr1'},
                    variant: {$type: 'variant'},
                    $style: { $shape: 'inlineListRelation',
                              $view: { join: ' / ', label: 'inline' } },
                },
            },

            other_regional_form: {
                $type: 'relation',
                $tag: OtherRegionalFormTag,
                other_regional_form_id: {$type: 'primary_key'},
                other_regional_form_text: {$type: 'string', $bind: 'attr1'},
                variant: {$type: 'variant'},
                // Hidden from the read view for now (the hand renderer doesn't
                // surface it either); public display is a later refinement.
                // Rare: no empty slot - add via the subentry menu.
                $style: { $shape: 'inlineListRelation',
                          $view: { hidden: true, label: 'inline', emptyEdit: 'menu' } },
            },

            picture: {
                $type: 'relation',
                $tag: PictureTag,
                picture_id: {$type: 'primary_key'},
                picture: {$type: 'image', $bind: 'attr1'},
                title: {$type: 'string', $bind: 'attr2'},
                credit: {$type: 'string', $bind: 'attr3'},
                $style: { $shape: 'inlineListRelation' },
            },

            attr: {
                $type: 'relation',
                $tag: AttrTag,
                attr_id: {$type: 'primary_key'},
                attr: {$type: 'string', $bind: 'attr1'},
                value: {$type: 'string', $bind: 'attr2', $style: { $width: 50 }},
                // attr is sometimes mikmaq text, thus mixed, allowAll, and defaultAll
                variant: {$type: 'variant', $mixed: true, $allowAll: true, $defaultAll: true},
                // A key/value bag (shoebox-date, twitter-post, borrowed-word, ...).
                // Keyed: each row is "Key: value"; an internal audience sees all
                // keys, the public site only the configured publicKeys
                // (borrowed-word).
                $style: { $shape: 'inlineListRelation',
                          $view: { order: 8, keyField: 'attr' } },
            },

            document_reference: {
                $type: 'relation',
                $tag: DocumentReferenceTag,
                document_reference_id: {$type: 'primary_key'},
                bounding_group_id: {$type: 'integer', $bind: 'attr1',
                                    $style: { $shape: 'boundingGroup'}},
                $style: { $shape: 'containerRelation',
                          $view: { order: 9, label: 'heading', empty: 'elide' } },

                transcription: {
                    $type: 'relation',
                    $tag: RefTranscriptionTag,
                    transcription_id: {$type: 'primary_key'},
                    transcription: {$type: 'string', $bind: 'attr1', $style: { $width: 60, $height: 5 }},
                    $style: { $shape: 'compactInlineListRelation',
                              $view: { order: 1, label: 'inline', empty: 'elide' } },
                },

                expanded_transcription: {
                    $type: 'relation',
                    $tag: RefExpandedTranscriptionTag,
                    $prompt: 'Expanded',
                    expanded_transcription_id: {$type: 'primary_key'},
                    expanded_transcription: {$type: 'string', $bind: 'attr1', $style: { $width: 60, $height: 5 }},
                    $style: { $shape: 'compactInlineListRelation',
                              $view: { order: 2, label: 'inline', empty: 'elide' } },
                },

                transliteration: {
                    $type: 'relation',
                    $tag: RefTransliterationTag,
                    transliteration_id: {$type: 'primary_key'},
                    transliteration: {$type: 'string', $bind: 'attr1', $style: { $width: 60, $height: 5 }},
                    // The SOURCE's orthography (provenance) - survives
                    // every orthography-selection filter.
                    variant: {$type: 'variant', $mixed: true, $sourceOrthography: true},
                    $style: { $shape: 'compactInlineListRelation',
                              $view: { order: 3, label: 'inline', empty: 'elide' } },
                },

                source_as_entry: {
                    $type: 'relation',
                    $tag: RefSourceAsEntryTag,
                    source_as_entry_id: {$type: 'primary_key'},
                    source_as_entry: {$type: 'string', $bind: 'attr1', $style: { $width: 60, $height: 5 }},
                    // The SOURCE's orthography (provenance) - survives
                    // every orthography-selection filter.
                    variant: {$type: 'variant', $mixed: true, $sourceOrthography: true},
                    $style: { $shape: 'compactInlineListRelation',
                              $view: { order: 4, label: 'inline', empty: 'elide', emptyEdit: 'menu' } },
                },

                normalized_source_as_entry: {
                    $type: 'relation',
                    $tag: RefNormalizedSourceAsEntryTag,
                    normalized_source_as_entry_id: {$type: 'primary_key'},
                    normalized_source_as_entry: {$type: 'string', $bind: 'attr1', $style: { $width: 60, $height: 5 }},
                    // The SOURCE's orthography (provenance) - survives
                    // every orthography-selection filter.
                    variant: {$type: 'variant', $mixed: true, $sourceOrthography: true},
                    $style: { $shape: 'compactInlineListRelation',
                              $view: { order: 5, label: 'inline', empty: 'elide', emptyEdit: 'menu' } },
                },

                foreign_reference: {
                    $type: 'relation',
                    $tag: RefForeignReferenceTag,
                    foreign_reference_id: {$type: 'primary_key'},
                    foreign_reference: {$type: 'string', $bind: 'attr1', $style: { $width: 60 }},
                    // The SOURCE's orthography (provenance) - survives
                    // every orthography-selection filter.
                    variant: {$type: 'variant', $mixed: true, $sourceOrthography: true},
                    $style: { $shape: 'compactInlineListRelation',
                              $view: { order: 6, label: 'inline', empty: 'elide', emptyEdit: 'menu' } },
                },

                note: {
                    $type: 'relation',
                    $tag: RefNoteTag,
                    note_id: {$type: 'primary_key'},
                    note: {$type: 'string', $bind: 'attr1', $style: { $width: 60, $height: 5, $markdown: true }},
                    // The EDITORIAL note - never published (public_note is
                    // the public one); generalizes renderInternalNotes.
                    $style: { $shape: 'compactInlineListRelation',
                              $view: { order: 7, label: 'inline', empty: 'elide',
                                       audience: 'internal' } },
                },

                public_note: {
                    $type: 'relation',
                    $tag: RefPublicNoteTag,
                    $prompt: 'Public note',
                    public_note_id: {$type: 'primary_key'},
                    public_note: {$type: 'string', $bind: 'attr1', $style: { $width: 60, $height: 5, $markdown: true }},
                    variant: {$type: 'variant', $mixed: true, $allowAll: true, $defaultAll: true},
                    $style: { $shape: 'compactInlineListRelation',
                              $view: { order: 8, label: 'inline', empty: 'elide', emptyEdit: 'menu' } },
                },
                
                // note: {
                //     $type: 'relation',
                //     $tag: RefNoteTag,
                //     ref_note_id: {$type: 'primary_key'},
                //     note: {$type: 'string', $bind: 'attr1', $style: { $width: 60 }},
                //     $style: { $shape: 'compactInlineListRelation' },
                // },
            },

            source: {
                $type: 'relation',
                $tag: SourceTag,
                source_id: {$type: 'primary_key'},
                source: {$type: 'string', $bind: 'attr1', $style: { $width: 60 }},
                variant: {$type: 'variant', $mixed: true, $allowAll: true, $defaultAll: true},
                // Rare: no empty slot - add via the subentry menu.
                $style: { $shape: 'inlineListRelation',
                          $view: { hidden: true, label: 'inline', emptyEdit: 'menu' } },
            },
        },

        recording: {
            $type: 'relation',
            $tag: RecordingTag,
            $prompt: 'Recordings',
            recording_id: {$type: 'primary_key'},
            recording: {$type: 'audio', $bind: 'attr1'},
            speaker: {$type: 'enum', $bind: 'attr2', $style: {$options: users}},
            variant: {$type: 'variant', $notVariant: true},
            // Entry-level, rendered before the senses (like the hand renderer).
            $style: { $shape: 'inlineListRelation',
                      $view: { order: 2, label: 'heading', empty: 'elide' } },
        },

        // The session LOG (dz 2026-07-09, converged in discussion): quick
        // capture of group-sitting feedback on a word - "better
        // unstructured collection IN the system than out of it".
        // TOP-POSTED: postLog gives each new fact an order_key before the
        // current first, so the raw data reads in its intended
        // interpretation order everywhere (the model's user-specified
        // order, not a display filter); true chronology stays on
        // valid_from.  Author/date come free from the assertion columns.
        // LAST in the model so internal views put it at the bottom.
        // audience internal: never publicly rendered, stripped from the
        // public bundle.  hidden: the word view renders its own Log pane
        // (with the quick Post box - see wordwiki.postLexemeLog); the
        // lexeme editor's generic machinery gives editing/reordering.
        log: {
            $type: 'relation',
            $tag: LogTag,
            log_id: {$type: 'primary_key'},
            log: {$type: 'string', $bind: 'attr1',
                  $style: { $width: 80, $height: 3, $markdown: true }},
            $style: { $shape: 'compactInlineListRelation',
                      $view: { hidden: true, label: 'inline', audience: 'internal',
                               byline: true } },
        },
    },
};

// interface Dictionary extends TupleVersionT {
// }

export interface Entry {
    entry_id: number,
    spelling: Spelling[],
    status: Status[],
    public: Public[],
    todo: Todo[],
    subentry: Subentry[],
    recording: Recording[],
    log: Log[],
}

/** A session-log entry (author/date live on the assertion columns). */
export interface Log {
    log_id: number,
    log: string,
}

export interface Status {
    status_id: number,
    status: string,
    details: string,
}

export interface Public {
    public_id: number,
    variant: string,
}

export interface Todo {
    todo_id: number,
    todo: string,
    details: string,
    assigned_to: string,
    done: number,
    variant: string,
}

export interface Spelling {
    spelling_id: number,
    text: string,
    variant: string,
}

export interface Subentry {
    subentry_id: number,
    part_of_speech: string,
    translation: Translation[],
    definition: Definition[],
    gloss: Gloss[],
    example: Example[],
    //recording: Recording[],
    pronunciation_guide: PronunciationGuide[],
    category: Category[],
    related_entry: RelatedEntry[],
    alternate_grammatical_form: AlternateGrammaticalForm[],
    other_regional_form: OtherRegionalForm[],
    attr: Attr[],
    document_reference: DocumentReference[],
    source: Source[],
}

export interface Translation {
    translation_id: number,
    translation: string,
}

export interface Definition {
    definition_id: number,
    definition: string,
}

export interface Gloss {
    gloss_id: number,
    gloss: string,
}

export interface Example {
    example_id: number,
    translation: string,
    example_text: ExampleText[],
    example_translation: ExampleTranslation[],
    example_recording: ExampleRecording[],
}

export interface ExampleText {
    example_text_id: number,
    example_text: string,
    variant: string,
}

export interface ExampleTranslation {
    example_translation_id: number,
    example_translation: string,
    variant: string,
}

export interface ExampleRecording {
    recording_id: number,
    speaker: string,
    recording: string,
    variant: string,
}

export interface PronunciationGuide {
    pronunciation_guide_id: number,
    pronunciation_guide: string,
    variant: string,
}

export interface Category {
    category_id: number,
    category: string,
}

export interface RelatedEntry {
    related_entry_id: number,
    unresolved_text: string,
}

export interface AlternateGrammaticalForm {
    alternate_grammatical_form_id: number,
    gloss: string,
    grammatical_form: string,
    alternate_form_text: AlternateFormText[],
}

export interface AlternateFormText {
    alternate_form_text_id: number,
    alternate_form_text: string,
    variant: string,
}

export interface OtherRegionalForm {
    other_regional_form_id: number,
    text: string,
}

export interface Attr {
    attr_id: number,
    attr: string,
    value: string,
}

export interface DocumentReference {
    document_reference_id: number,
    bounding_group_id: number,
    transcription: RefTranscription[],
    expanded_transcription: RefExpandedTranscription[],
    transliteration: RefTransliteration[],
    source_as_entry: RefSourceAsEntry[],
    normalized_source_as_entry: RefNormalizedSourceAsEntry[],
    foreign_reference: RefForeignReference[],
    note: RefNote[],
    public_note: RefPublicNote[],
}

export interface RefTranscription {
    transcription_id: number,
    transcription: string,
}

export interface RefExpandedTranscription {
    expanded_transcription_id: number,
    expanded_transcription: string,
}

export interface RefTransliteration {
    transliteration_id: number,
    transliteration: string,
}

export interface RefSourceAsEntry {
    source_as_entry_id: number,
    source_as_entry: string,
}

export interface RefNormalizedSourceAsEntry {
    normalized_source_as_entry_id: number,
    normalized_source_as_entry: string,
}

export interface RefForeignReference {
    foreign_reference_id: number,
    foreign_reference: string,
}

export interface RefNote {
    note_id: number,
    note: string,
}

export interface RefPublicNote {
    public_note_id: number,
    public_note: string,
}

export interface Source {
    source_id: number,
    text: string,
    variant: string,
}

export interface Recording {
    recording_id: number,
    speaker: string,
    recording: string,
    variant: string,
}

// The orthography today's public site renders (and therefore the pub gate it
// composes on).  Publishing more orthographies = more calls with other values.
// The VALUE lives in the per-community site config.
export const PUBLIC_SITE_ORTHOGRAPHY = siteConfig.publicSiteOrthography;

/**
 * THE COMPOSITION RULE (fix-orthographies.md "Status"): a word is public in
 * orthography O iff its lifecycle is not Archived* AND its per-orthography
 * publish gate pub(O) is set.  THE GATE IS THE PUBLISHED DIMENSION - a
 * PENDING pub proposal gates nothing - so feed this the PUBLISHED projection
 * (WordWiki.publishedEntries does; its e.public then contains only
 * published-current gate facts).  Over the current/editor projection the
 * answer includes pending proposals - use lexemeOps.currentPublicGates for
 * gate truth there.  Replaces the old isPublished status==='Completed'
 * check: lifecycle no longer implies publicness.
 */
export function entryIsPublicIn(e: Entry, orthography: string): boolean {
    return !isArchivedEntry(e)
        && (e.public ?? []).some(p => variantMatches(p.variant, orthography));
}

/**
 *
 */
export function computeNormalizedSearchTerms(e: Entry): string[] {
    // XXX crap - fix, think harder etc.
    const spellings = e.spelling.map(s=>s.text).map(s=>s.replaceAll(/[^A-Za-z0-9_]/g, "_"));
    const glosses = e.subentry.flatMap(se=>se.gloss.flatMap(gl=>gl.gloss.split(' ').map(word=>word.replaceAll(/[^A-Za-z0-9_]/g, "_"))));
    const allTermsAsAString = (spellings.join(' ')+' '+glosses.join(' ')).toLowerCase();
    const allTerms = allTermsAsAString.split(' ');
    return allTerms;
}

// XXX DO THIS PROPERLY!!!!
const defaultVariant = siteConfig.publicSiteOrthography;

/** The entry's spellings in ONE orthography lane (legacy blanks count as
 *  every lane).  Default: the public site's orthography; pass another to
 *  present the entry in that lane (e.g. the SF-ready report forces mm-sf
 *  so users see the word as the SF site would show it). */
export function getSpellings(e: Entry, orthography: string = defaultVariant): Spelling[] {
    return e.spelling.filter(s=>s.variant == orthography || !s.variant);
}

/**
 *
 */
// The tiny lane label for the fallback spelling's superscript (the
// editor's Li/SF badge vocabulary) - injected by the app (the
// abbreviations live in the orthography table); un-injected shows the
// raw slug.
let orthographyAbbrHook: ((slug: string) => string) | undefined;
export function setOrthographyAbbrHook(fn: (slug: string) => string): void {
    orthographyAbbrHook = fn;
}

export function renderEntryCompactSummary(e: Entry, opts: {orthography?: string} = {}): any {
    return ['div', {}, renderEntryCompactSummaryCore(e, opts)];
}

// Note the factoring into Summary/SummaryCore should be replaced, this is
// just done for compat.
export function renderEntryCompactSummaryCore(e: Entry, opts: {orthography?: string} = {}): any {
    const spellings = getSpellings(e, opts.orthography).map(s=>s.text);
    // No spelling in the selected lane: show the FIRST spelling in any
    // lane, greyed with its lane superscript (dz: wrong-orthography text
    // is still somewhat readable cross-ortho, and beats a blank headword;
    // no per-lane fallback chains for now).
    const fallback = spellings.length === 0 ? e.spelling[0] : undefined;
    const headword = fallback
        ? ['strong', {}, ['span', {class: 'text-muted'}, fallback.text],
           ['span', {class: 'lm-me-orth'},
            orthographyAbbrHook?.(fallback.variant ?? '') ?? (fallback.variant ?? '')]]
        : ['strong', {}, spellings.join(', ')];
    const glosses = e.subentry.flatMap(se=>se.gloss.map(gl=>gl.gloss));
    return [headword,
            // Archival is our delete, but archived words still appear in
            // internal searches/lists - so their presentation line says so.
            isArchivedEntry(e)
                ? ['span', {class: 'badge text-bg-secondary ms-1 me-1'}, 'ARCHIVED'] : undefined,
            ' : ', glosses.join(' / ')];
}

/**
 *
 */
export function renderEntryTitle(e: Entry): string {
    // TODO handle dialects here.
    const spellings = getSpellings(e).map(s=>s.text);
    const glosses = e.subentry.flatMap(se=>se.gloss.map(gl=>gl.gloss));
    const archived = isArchivedEntry(e) ? ' [ARCHIVED]' : '';
    // TODO mikmaq online text here should come from config XXXX
    return `${spellings.join(', ')}${archived} :: ${glosses.join(' / ')} -- Mi'gmaq/Mi'kmaq Online`;
}

export function renderEntrySpellingsSummary(e: Entry, orthography?: string): string {
    return getSpellings(e, orthography).map(s=>s.text).join('/');
}

/**
 * Pick one recording to feature in situations where there is only space
 * to render one recording link.
 * 
 * Choice is based on entry_id so that choice is stable.
 * 
 * Currently ignoring variant + should have other controls.  XXX TODO
 */
export function getStableFeaturedRecording(e: Entry): Recording|undefined {
    return e.recording.length === 0
        ? undefined
        : e.recording[e.entry_id % e.recording.length];
}

// The parsed dict schema as a module-level lazy singleton, for consumers
// with no app instance (the publisher renders entry metadata against it).
// Parsing is deterministic, so this is interchangeable with the store's copy.
let _parsedDictSchema: model.Schema|undefined;
export function parsedDictSchema(): model.Schema {
    return _parsedDictSchema ??= model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson);
}

function test() {
    const dictSchema = model.Schema.parseSchemaFromCompactJson('dict', dictSchemaJson);
    console.info('Schema', dictSchema);
    const dumpedEntrySchemaJson = dictSchema.schemaToCompactJson();
    console.info('Schema again', dumpedEntrySchemaJson);
}

// TODO Generizise the entry rendering, then do the whole lexeme.
// TODO Figure out research section.


function contextMenuPlay(): any {
    const items = [
        { name: 'Cut', fn: function(target:Element) { console.log('Cut!', target); }},
        { name: 'Copy', fn: function(target:Element) { console.log('Copy!', target); }},
        { name: 'Paste', fn: function(target:Element) { console.log('Paste!', target); }},
        {},
        { name: 'Select All', fn: function(target:Element) { console.log('Select All!', target); }},
    ];

    const cm1 = new ContextMenu('.has-context-menu', items);

    return ['div', {class: 'has-context-menu'}, 'CTX ME!'];
}

// later, will add dialect.
interface RenderCtx {
    rootPath: string;
    suppressReferenceImages?: boolean;
    renderInternalNotes?: boolean,
    noTargetOnRefImages?: boolean;
    docRefsFirst?: boolean;
    // Bundle-backed scan renderers (publish-source.md): when set, document
    // references render through these instead of the db-backed module
    // functions - a from-dump publish renders scans with NO db.  All three
    // return the same shapes the db-backed defaults do ('' = unresolvable).
    scanRenderers?: {
        renderStandaloneGroup(rootPath: string, bounding_group_id: number): any;
        publicBookPageUrl(rootPath: string, bounding_group_id: number): string;
        imageRefDescription(bounding_group_id: number): string;
    };
    // Bundle-backed audio urls (the publish-source media manifest): when
    // set, recordings render from build-time-resolved derived paths - no
    // derivation machinery (and no source audio) at render time.
    resolveAudioUrl?: audio.AudioUrlResolver;
    // The speaker's DISPLAY label beside a recording - "Name (Region)"
    // (dz 2026-07-09: the region, from the user record, in brackets).
    // Uninjected renders the stored username, as always; the publisher
    // injects a bundle-backed label, the word view a table-backed one.
    speakerLabel?: (username: string) => string;
    // Entry pages: repeat the meanings on the title line after the headword
    // (`headword : meanings`) - the audience is largely non-fluent, so the
    // English must be right up front.  Same slash-joined form as the
    // published word lists.
    glossInTitle?: boolean;
}

/**
 *
 * Switch to mm-li query for now.
 */
export function renderEntry(ctx: RenderCtx, e: Entry): any {
    const glosses = ctx.glossInTitle
        ? e.subentry.flatMap(se=>se.gloss.map(gl=>gl.gloss))
        : [];
    return [
        //contextMenuPlay(),
        ['h1', {class: 'entry-scope'},
         renderEntrySpellings(ctx, e, getSpellings(e)),
         glosses.length > 0
             ? ['span', {class: 'entry-gloss-title'}, ' : ', glosses.join(' / ')]
             : []],
        renderEntryRecordings(ctx, e, e.recording),
        renderSubentriesCompact(ctx, e, e.subentry),
    ];
}

export function renderEntrySpellings(ctx: RenderCtx, e: Entry, spellings: Spelling[]): string {
    return spellings.map(s=>s.text).join('/') || 'No Spellings';
}

export function renderEntryRecordings(ctx: RenderCtx, e: Entry, recordings: Recording[]): any {
    return recordings.length === 0 ? [] : [
        ['div', {class: 'entry-scope'},
         ['b', {}, 'Recordings:'],
         ['ul', {},
          recordings.length === 0
             ? ['li', {}, 'No recordings']
             : recordings.map(r=>['li', {},
                                  audio.renderAudio(r.recording, `Recording by ${ctx.speakerLabel?.(r.speaker) ?? r.speaker}`, undefined, ctx.rootPath, undefined, ctx.resolveAudioUrl)])
         ] // ul
        ]
    ];
}

export function renderSubentriesCompact(ctx: RenderCtx, e: Entry, subentries: Subentry[]): any {
    switch(subentries.length) {
        case 0:
            return ['p', {class: 'entry-scope'}, 'No entries'];
        case 1:
            return renderSubentry(ctx, e, subentries[0]);
        default:
            return renderSubentries(ctx, e, subentries);
    }
}

export function renderSubentries(ctx: RenderCtx, e: Entry, s: Subentry[]): any {
    return [
        ['ul', {},
         s.map((s, idx)=>['li', {}, [
             ['h3', {}, `${idx+1}.`], renderSubentry(ctx, e, s)]])]];
}

export function renderSubentry(ctx: RenderCtx, e: Entry, s: Subentry): any {
    return [
        // renderSource(e, s, s.source),
        ctx.docRefsFirst ? renderDocumentReferences(ctx, e, s, s.document_reference) : undefined,

        renderTranslations(ctx, e, s, s.translation),
        renderPartOfSpeech(ctx, e, s, s.part_of_speech),
        //s.definition.map(t=>[['div', {}, ['b', {}, 'Definition: '], t.definition]]),
        renderGlosses(ctx, e, s, s.gloss),
        //s.example.map(x=>renderExample(e, x)),
        renderExamples(ctx, e, s, s.example),

        renderPronunciationGuides(ctx, e, s, s.pronunciation_guide),
        ['br', {}],
        renderRelatedEntries(ctx, e, s, s.related_entry),
        renderAlternateGrammaticalForms(ctx, e, s, s.alternate_grammatical_form),
        renderBorrowedWords(ctx, e, s, s.attr),
        !ctx.docRefsFirst ? renderDocumentReferences(ctx, e, s, s.document_reference) : undefined,
    ];
}

export function renderPartOfSpeech(ctx: RenderCtx, e: Entry, s: Subentry, part_of_speech: string): any {
    return ['div', {},  ['b', {}, 'Part of Speech: '], partsOfSpeech[part_of_speech] ?? part_of_speech];
}

export function renderPronunciationGuides(ctx: RenderCtx, e: Entry, s: Subentry,
                                          pronunciationGuides: PronunciationGuide[]): any {
    if(!pronunciationGuides)
        throw new Error('missing pron guides');
    return [['div', {class: 'entry-scope'},
             pronunciationGuides.map(p=>renderPronunciationGuide(ctx, e, s, p))
            ]];
}

export function renderPronunciationGuide(ctx: RenderCtx, e: Entry, s: Subentry, p: PronunciationGuide): any {
    return [['div', {},  ['b', {}, 'Pronunciation Guide: '], p.pronunciation_guide]];
}

export function renderTranslations(ctx: RenderCtx, e: Entry, s: Subentry, translations: Translation[]): any {
    return [['div', {class: 'entry-scope'},
             translations.map(t=>renderTranslation(ctx, e, s, t))
            ]];
}

export function renderTranslation(ctx: RenderCtx, e: Entry, s: Subentry, t: Translation): any {
    return [['div', {},  ['b', {}, 'Translation: '], t.translation]];
}
// export function renderCompactList(e: Entry,
//                                   parentId: number,
//                                   parentRelationTag: string,

export function renderGlosses(ctx: RenderCtx, e: Entry, s: Subentry, glosses: Gloss[]): any {
    return glosses.length === 0 ? [] : [
        ['div', {class: 'entry-scope'},
         ['b', {}, 'Meanings:'],
          ['ul', {},
           glosses.length === 0
              ? ['li', {}, 'No glosses']
              : glosses.map(g=>['li', {}, g.gloss])]
         ]
     ];
}

export function renderExamples(ctx: RenderCtx, e: Entry, s: Subentry, examples: Example[]): any {
    return examples.length === 0 ? [] : [
        ['div', {class: 'entry-scope'},
         ['b', {}, 'Example of word used in a sentence:'],
         ['ul', {},
          examples.length === 0
             ? ['li', {}, 'No examples']
             : examples.map(example=>['li', {}, renderExample(ctx, e, example)])]
        ]
    ];
}

export function renderExample(ctx: RenderCtx, e: Entry, example: Example): any {
    return [
        example.example_text.filter(t=>t.variant==defaultVariant || !t.variant).map(t=>['div', {}, ['b', {}, 'Text: '], t.example_text]),
        example.example_translation.map(t=>['div', {}, ['b', {}, 'Translation: '], ['i', {}, t.example_translation]]),
        example.example_recording.map(r=>['div', {}, ['b', {}, 'Recording: '], audio.renderAudio(r.recording, [`Recording by ${ctx.speakerLabel?.(r.speaker) ?? r.speaker} `, audio.audioPlayIcon], undefined, ctx.rootPath, undefined, ctx.resolveAudioUrl)])
    ];
}

export function renderRelatedEntries(ctx: RenderCtx, e: Entry, s: Subentry,
                                     relatedEntries: RelatedEntry[]): any {
    if(!relatedEntries)
        throw new Error('missing related entries');
    return [['div', {class: 'entry-scope'},
             relatedEntries.map(r=>renderRelatedEntry(ctx, e, s, r))
            ]];
}

export function renderRelatedEntry(ctx: RenderCtx, e: Entry, s: Subentry, r: RelatedEntry): any {
    return [['div', {},  ['b', {}, 'Related Entry: '], r.unresolved_text]];
}

export function renderAlternateGrammaticalForms(ctx: RenderCtx, e: Entry, s: Subentry,
                                                alternateForms: AlternateGrammaticalForm[]): any {
    return alternateForms.length === 0 ? [] : [
        ['div', {class: 'entry-scope'},
         ['b', {}, 'Alternate Grammatical Forms:'],
         ['ul', {},
          alternateForms.length === 0
             ? ['li', {}, 'No alternate forms']
             : alternateForms.map(a=>['li', {}, renderAlternateGrammaticalForm(ctx, e, s, a)])]
        ]
    ];
}

export function renderAlternateGrammaticalForm(ctx: RenderCtx, e: Entry, s: Subentry, a: AlternateGrammaticalForm): any {
    return [a.alternate_form_text.map(t=>[t.alternate_form_text, " -- "]),
            ['i', {}, a.gloss], " -- ",
            '(', GrammaticalFormDescriptions[a.grammatical_form] ?? a.grammatical_form, ')'
           ];
}

export function renderBorrowedWords(ctx: RenderCtx, e: Entry, s: Subentry,
                                    attrs: Attr[]): any {
    if(!attrs)
        throw new Error('missing attrs');
    return [['div', {class: 'entry-scope'},
             attrs
             .filter(a=>a.attr === 'borrowed-word')
                 .map(r=>renderBorrowedWord(ctx, e, s, r))
            ]];
}

export function renderBorrowedWord(ctx: RenderCtx, e: Entry, s: Subentry, b: Attr): any {
    return [['div', {},  ['b', {}, 'Borrowed Word: '], b.value]];
}

export function renderDocumentReferences(ctx: RenderCtx, e: Entry, s: Subentry,
                                         documentReferences: DocumentReference[]): any {
    return documentReferences.length === 0 ? [] : [
        ['div', {class: 'entry-scope'},
         ['b', {}, 'Document References:'],
         ['ul', {},
          documentReferences.length === 0
             ? ['li', {}, 'No references']
             : documentReferences.map(ref=>['li', {}, renderDocumentReference(ctx, e, ref)]),
         ]
        ]
    ];
}

export function renderDocumentReference(ctx: RenderCtx, e: Entry, ref: DocumentReference): any {
    // XXX BAD THIS BIT OF FACTORING IS A CRAP HACK TO GET OUT THE DOOR.
    // XXX THE LINE with REMOVE_FOR_WEB is removed by transpile.sh so
    //     we don't try to pull client-side only deps on the web.
    let standaloneGroupRender: any = [];
    if(!ctx.suppressReferenceImages)
        standaloneGroupRender = ctx.scanRenderers
            ? ctx.scanRenderers.renderStandaloneGroup(ctx.rootPath, ref.bounding_group_id)
            : renderStandaloneGroup(ctx.rootPath, ref.bounding_group_id); // REMOVE_FOR_WEB
    const title = 'Title';
    let refUrl: string;
    if(ctx.scanRenderers) {
        refUrl = ctx.scanRenderers.publicBookPageUrl(ctx.rootPath, ref.bounding_group_id);
    } else try {
        refUrl = pageEditorURLForBoundingGroup(ref.bounding_group_id); // REMOVE_FOR_WEB
    } catch(ex) {
        refUrl = '';
    }

    let refDescription: string;
    if(ctx.scanRenderers) {
        refDescription = ctx.scanRenderers.imageRefDescription(ref.bounding_group_id);
    } else try {
        refDescription = imageRefDescription(ref.bounding_group_id); // REMOVE_FOR_WEB
    } catch(ex) {
        refDescription = '';
    }

    const noBody =
        ref.transcription.length === 0 &&
        ref.expanded_transcription.length === 0 &&
        ref.transcription.length === 0 &&
        ref.note.length === 0;
    return [
        ['div', {},
         ctx.noTargetOnRefImages
            ? standaloneGroupRender
            : ['a', {href:refUrl /*, target:'_blank', rel:'opener'*/}, standaloneGroupRender]],

        ['div', {},
         ctx.noTargetOnRefImages
            ? refDescription
            : ['a', {href:refUrl /*, target:'_blank', rel:'opener'*/}, refDescription]],

        ['div', {},
         /*noBody ? ['b', {}, 'No Transcription']:*/ undefined,
        ],
        ['table', {},
         ['tbody', {},
          // TODO move this style stuff to the stylesheet
          ref.transcription.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Transcription:'], ['td', {}, t.transcription]]),
          ref.expanded_transcription.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Expanded:'], ['td', {}, t.expanded_transcription]]),
          ref.transliteration.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Transliteration:'], ['td', {}, t.transliteration]]),
          ref.source_as_entry.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Source as entry:'], ['td', {}, t.source_as_entry]]),          
          ref.normalized_source_as_entry.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Normalized source as entry:'], ['td', {}, t.normalized_source_as_entry]]),
          ref.foreign_reference.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Foreign reference:'], ['td', {}, t.foreign_reference]]),
          
          // The note fields are $markdown (dictSchemaJson): the reference
          // tables render them through the shared markdown pipeline.
          ctx.renderInternalNotes ? ref.note.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Note:'], ['td', {}, markdownToMarkup(t.note)]]) : [],
          ref.public_note.map(t=>['tr', {}, ['th', {style: 'vertical-align: top;'}, 'Public Note:'], ['td', {}, markdownToMarkup(t.public_note)]]),
          //ref.transcription.map(t=>['div', {}, ['b', {}, 'Transcription: '], t.text]),
          //ref.expanded_transcription.map(t=>['div', {}, ['b', {}, 'Expanded Transcription: '], t.text]),
          //ref.text.map(t=>['div', {}, ['b', {}, 'Text: '], t.text]),
          //ref.note.map(t=>['div', {}, ['b', {}, 'Note: '], t.text]),
    ]]];
}


if (import.meta.main)
    //await bunny();
    await test();
