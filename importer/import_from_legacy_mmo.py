import datetime
import pprint
import json
import sys
from pathlib import Path
import re
#import mmodb
#import util
import os
import rtoml
import tomli_w
import pytomlpp
from pathlib import Path
import gzip
import nanoid

sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')

def lexeme_to_id(lexeme):
    return re.sub(r"[^A-Za-z0-9_]", "_", lexeme.lower())

def import_legacy_mmo(i_realize_that_this_will_nuke_the_working_mmo_db=False):
    assert i_realize_that_this_will_nuke_the_working_mmo_db == True

    # Load lexemes we have exported from legacy mmo
    mmo_json = None
    #mmo_gzip_path = os.path.dirname(__file__)+'/legacy-mmo.json.gz';
    #print('Reading legacy mmo data from', mmo_gzip_path)
    #with gzip.open(mmo_gzip_path) as f:
    #    mmo_json = json.load(f)
    #mmo_path = os.path.dirname(__file__)+'/legacy-mmo.json'
    mmo_path = '/home/dziegler/mmo/imports/LegacyMmo/legacy-mmo-dump.json'
    print('Reading legacy mmo data from', mmo_path)
    with open(mmo_path) as f:
        mmo_json = json.load(f)
    assert len(mmo_json) == 1, f"Expected root of mmo.json to be dict with one key"
    lexemes = mmo_json['lexemes']
    print('Loaded', len(lexemes), 'lexemes')

    legacy_lexemes_by_name = {l['name']: l for l in lexemes}
    
    # Assert some things about the lexemes that we are investigating or
    # depending on.
    lexemes_with_multiple_parts_of_speech = 0
    for l in lexemes:
        lexeme_id = l['id']
        #print(l)
        subentries = l['subentries']
        if len(subentries) != 1:
            #print(lexeme_id, 'has', len(subentries), 'subentries')
            assert len(subentries) == 1, "Only one subentry per word supported"
        subentry = subentries[0]
        parts_of_speech = subentry['partsOfSpeech']
        if len(parts_of_speech) != 1:
            print(lexeme_id, 'has', len(parts_of_speech), 'parts of speech')
            assert len(parts_of_speech) <= 3, "No more than 3 parts of speech"
            assert len(parts_of_speech) != 0, "word has no parts of speech"
            lexemes_with_multiple_parts_of_speech = lexemes_with_multiple_parts_of_speech + 1

    print(f"{lexemes_with_multiple_parts_of_speech} lexemes with multiple parts of speech")
    id_allocator = LocalIdAllocator(next_id = 100)

    # convert to new format
    entries = []
    for src_lexeme in lexemes:
        entries.extend(convert_lexeme_to_entries(id_allocator, legacy_lexemes_by_name, src_lexeme))

    # convert to NestedText (just for a human readable version)
    #nestedtext_content = nt.dumps(entries, indent=2, width=0) + "\n"
    #with open('entries.nt', 'w') as f:
    #    f.write(nestedtext_content)

    # validate
    #model = entry_model_factory.model()
    #model.bind_field_paths(None) # XXX should not be here.
    #for e in entries:
    #    model.validate(e)
    
    # import into database
    #import_json_into_db(model, entries)

    root = 'mikmaq'
    root = '/home/dziegler/mmo/imports/LegacyMmo'
    os.makedirs(root, exist_ok=True)
    
    # import into fs
    #import_json_into_fs(root, None, entries)


    #os.makedirs(root+'/categories')

    
    # spew new format to JSON
    # Note: we are doing this after import to DB so that we can see the
    #       _id fields that get added int the db import process
    #os.makedirs(root+'/import-report')
    with open(root+'/entries.json', 'w') as f:
        json.dump(entries, f, sort_keys=False, indent=2, ensure_ascii=False)

    # spew leftovers to JSON
    with open(root+'/leftovers.json', 'w') as f:
        json.dump(lexemes, f, sort_keys=False, indent=2, ensure_ascii=False)
    
def import_json_into_fs(root, model, entries):
    print(f'Importing entries into directory {root}')
    for e in entries:
        public_id = e['public_id']
        assert public_id, 'Missing or empty public_id'
        entry_dir = f'{root}/entries/{public_id[0]}/{public_id}'
        os.makedirs(entry_dir, mode=0o777, exist_ok=True)
        entry_file = f'{entry_dir}/data.toml'
        #e = {'cat': 7}
        #del e['_id']
        #del e['last_modified_date']
        #del e['internal_note']
        #del e['public_note']
        #del e['part_of_speech']
        #print('E', e)
        #print('E', json.dumps(e, indent=2, ensure_ascii=False))
        #rtoml.dump(e, Path(entry_file), pretty=True)
        e['body_text'] = 'multi\nline\nbody\ntext'
        pytomlpp.dump(e, Path(entry_file))
        #with open(entry_file, 'w') as f:
        #    json.dump(e, f, sort_keys=True, indent=2, ensure_ascii=False)
        #e = {'cat': 7}
        #with open(entry_file, 'wb') as f:
        #    tomli_w.dump(e, f, multiline_strings=True)
        #    #json.dump(e, f, sort_keys=True, indent=2, ensure_ascii=False)

class LocalIdAllocator:
    def __init__(self, next_id=100):
        self.next_id = next_id

    def alloc_next_id(self):
        id = self.next_id
        self.next_id += 1
        return id


class LocalIdAllocator_OFF:
    def __init__(self, next_id=100):
        self.next_id = next_id

    def alloc_next_id(self):
        return nanoid.generate('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 16)
   
        
def convert_lexeme_to_entries(id_allocator, legacy_lexemes_by_name, src_lexeme):

    attrs = dict()
    # Local ids should not be entirely predictable, but should
    # be consistent from import to import - so we base them on hash(name)
    #initial_local_id = 100 + hash(src_lexeme['name']) % 50
    #id_allocator = LocalIdAllocator(next_id = initial_local_id)
    
    date = src_lexeme.pop('date') # TODO put date in.
    lexeme = src_lexeme.pop('name')
    derived_id = src_lexeme.pop('id')
    assert derived_id == lexeme_to_id(lexeme), f"id rederivation inconsistency lex:{lexeme} lex_to_id:{lexeme_to_id(lexeme)} imported_derived_id:{derived_id}"
    note = src_lexeme.pop('note')
    picture = src_lexeme.pop('picture')
    #if picture:
    #    print('picture', picture)
    # TODO status map
    status = src_lexeme.pop('status')
    print('STATUS', status)
    is_published = status == 'done' or status == 'post'
    #assert len(src_lexeme.pop('errors')) == 0 # TODO
    assert not src_lexeme.pop('explicitSfGloss')
    
    src_subentries = src_lexeme['subentries']
    assert len(src_subentries)==1, "Only one subentry per lexeme supported"
    #assert len(src_subentries)>=1, "Only one subentry per lexeme supported"
    #if len(src_subentries)!=1:
    #    print ('*** Ignoring extra subentries for', lexeme)
    src_subentry = src_subentries[0]
    src_parts_of_speech = src_subentry['partsOfSpeech']
    assert len(src_parts_of_speech) > 0, "Each lexeme must have at least one part of speech"
    watsonSpelling = src_lexeme.pop('watsonSpelling')
    if watsonSpelling and watsonSpelling != lexeme:
        attrs['watson_spelling'] = watsonSpelling
        
    borrowed_word = src_subentry.pop('borrowedWord')
    assert not src_subentry.pop('label')
    phonetic_form = src_subentry.pop('phoneticForm')

    sub_entries = []
    for (idx, pos) in enumerate(src_parts_of_speech):
        part_of_speech_label = pos.pop('label')
        attrs = dict()
        for sense in pos['senses']:
            sub_entries.extend(convert_sense(id_allocator, legacy_lexemes_by_name, date, lexeme, note, status, borrowed_word, phonetic_form, part_of_speech_label, [], sense, attrs, derived_id, len(sub_entries)))

    entry = dict()
    entry['entry_id'] = id_allocator.alloc_next_id()
    entry['published'] = is_published
    entry['spelling'] = ortho_text('spelling_id', id_allocator, lexeme)
    entry['recording'] = [convert_recording('recording_id', id_allocator, r) for r in src_subentry.pop('recordings')  if r['filename'] != '']
    entry['subentry'] = sub_entries
    # remodel date TODO toolbox last edit date.
    # TODO: change date format from "31/Jul/2019", to "2019-07-31"
    #entry['last_modified_date'] = date
    entry['internal_note'] = note
    entry['public_note'] = ''

    entry['status'] = [{
        'status_id': id_allocator.alloc_next_id(),
        'variant': 'mm-li',
        'status': status,
        'details': ''
    }]            
    
    
    return [entry]

# for pacific: picture of reference - what refer to

def convert_sense(id_allocator, legacy_lexemes_by_name, date, lexeme, note, status, borrowed_word, phonetic_form, part_of_speech_label, recordings, sense, attrs, public_id, idx):

    entry = dict()
    entry['subentry_id'] = id_allocator.alloc_next_id()
    #entry['public_id'] = f"{public_id}-{idx+1}" if idx > 0 else public_id
    #entry['lexeme'] = lex_text
    # remodel status TODO: skip/done ???
    #assert status=='done' or status=='skip', 'unknown status {status}'
    if borrowed_word:
        attrs['borrowed_word'] = borrowed_word
    
    # TODO is phonetic_form a li/sf thing as well?
    # - maybe different by ortho ...
    # - copy li to  ...
    entry['pronunciation_guide'] = ortho_text('pronunciation_guide_id', id_allocator, phonetic_form);
    entry['part_of_speech'] = part_of_speech_label

    # TODO should cross_ref resolve?  Try to resolve?
    # what does it mean anyway?
    # cross ref presently is in li.
    # Are supposed to resolve.
    # confusing cross ortho!!!
    # - Related words.
    # - Related lexemes.
    # - related_entries
    related_entries_text = sense.pop('crossRef').strip()
    related_entries_text = stripOptSuffix(related_entries_text, '.')
    related_entries_text = stripOptSuffix(related_entries_text, ',')
    related_entries_text = related_entries_text.replace(' and ', ',')
    related_entries = re.split(r"[ ]*,[ ]*", related_entries_text)
    related_entries = list(filter(lambda v: v, related_entries))
    # if related_entries_text:
    #     print(related_entries_text, related_entries)
    #     for r in related_entries:
    #         if legacy_lexemes_by_name.get(r):
    #             print('FOUND', r)
    #         else:
    #             print('NOT FOUND', r)
    entry['related_entry'] = [convert_related_entry(id_allocator, e) for e in related_entries]
                
    # try to resolve!
    #entry['related_entries'] = sense.pop('crossRef')  # TODO should be list of lexes
    entry['translation'] = [convert_translation(id_allocator, sense.pop('definition'))]
    #assert not sense.pop('label')
    notes = [n['text'] for n in sense.pop('notes')]
    #if note:
    #    print('entry notes:', note)
    #if notes:
    #    print('sense notes:', notes)

    if note:
        notes.append(note)
    if notes:
        print('all notes:', notes)

    entry['note'] = [convert_note(id_allocator, n) for n in notes]
    picture = sense.pop('picture')
    if picture:
        entry['picture'] = [convert_picture(id_allocator, picture)]

    scientific_name = sense.pop('scientificName')
    if scientific_name:
        attrs['scientific_name'] = scientific_name

    table = sense.pop('table')
    if table:
        attrs['legacy_alternate_grammatical_forms'] = table
    literally = sense.pop('literally')
    if literally:
        attrs['literally'] = literally
    
    #entry['recordings'] = recordings

    entry['example'] = [convert_example(id_allocator, ex) for ex in sense['examples']]
        
    entry['gloss'] = [convert_gloss(id_allocator, g) for g in sense.pop('glosses')]

    # Example conjugations
    # TODO rename to Alternate Forms
    entry['alternate_grammatical_form'] = [convert_alternate_form(id_allocator, af) for af in sense['lexicalFunctions']]

    # TODO can I rename to categories?
    entry['category'] = [convert_category(id_allocator, c) for c in sense.pop('semanticDomains')]
    
    # WTF: 'other_regional_forms', li, sf
    entry['other_regional_form'] = [convert_other_regional_form(id_allocator, f) for f in sense.pop('variantForms')]
    # - text, region, gloss

    entry['attr'] = convert_attrs(id_allocator, attrs)
    
    return [entry]

# "lexicalFunctions" : [ {
#     "gloss" : "I'm hanging around",
#     "label" : "1",
#     "lexeme" : "alei",
#     "sfGloss" : ""
#     }, { ... } ]
def convert_alternate_form(id_allocator, src):
    out = dict()
    out['alternate_grammatical_form_id'] = id_allocator.alloc_next_id()
    out['gloss'] = src.pop('gloss')
    out['grammatical_form'] = src.pop('label')
    out['alternate_form_text'] = ortho_text('alternate_form_text_id', id_allocator, src.pop('lexeme'), src.pop('sfGloss'))
    return out

def convert_note(id_allocator, note):
    out = dict()
    out['note_id'] = id_allocator.alloc_next_id()
    out['note'] = note
    return out

def convert_picture(id_allocator, picture):
    out = dict()
    out['picture_id'] = id_allocator.alloc_next_id()
    out['picture'] = picture
    return out


#          "examples" : [ {
#            "exampleEnglish" : "It's sitting on the bare ground, lay something under it.",
#            "exampleSentence" : "Metaqateg maqamigeg, natgoqwei lame'g lega'tu.",
#            "exampleSf" : "",
#            "recordings" : [ {
#              "filename" : "media/m/metaqateg/phrase1.wav",
#              "recordedBy" : "dmm"
#            } ]
#          } ],

def convert_translation(id_allocator, translation_text):
    out = dict()
    out['translation_id'] = id_allocator.alloc_next_id()
    # try to resolve - but need id to do that!
    # so, will need to pre-assign ids.
    out['translation'] = translation_text
    return out




def convert_related_entry(id_allocator, related_entry_name):
    out = dict()
    out['related_entry_id'] = id_allocator.alloc_next_id()
    # try to resolve - but need id to do that!
    # so, will need to pre-assign ids.
    out['unresolved_text'] = related_entry_name
    return out


def puppy(v):
    print('puppy', v)
    return True
    

def convert_example(id_allocator, src):
    out = dict()
    out['example_id'] = id_allocator.alloc_next_id()
    out['example_text'] = ortho_text('example_text_id', id_allocator, src.pop('exampleSentence'), src.pop('exampleSf'))
    #out['translation'] = src.pop('exampleEnglish')
    out['example_translation'] = [convert_example_translation(id_allocator, src.pop('exampleEnglish'))]
    out['example_recording'] = [convert_recording('example_recording_id', id_allocator, r) for r in src.pop('recordings') if r['filename'] != '']
    #out['recordings'] = src.pop('recordings')
    return out

def convert_example_translation(id_allocator, translation_txt):
    out = dict()
    out['example_translation_id'] = id_allocator.alloc_next_id()
    out['text'] = translation_txt
    return out

def convert_recording(id_field, id_allocator, src):
    out = dict()
    out[id_field] = id_allocator.alloc_next_id()
    #print(src)
    filename = src['filename']
    if filename.startswith('mediae/'):
        filename = filename.replace('mediae/', 'media/');
    if not filename.startswith('media/'):
        print('*** invalid media filename', "'"+filename+"'")
    #assert filename.startswith('media/')
    #out['recording'] = 'content/LegacyMmoRecordings/'+filename[len('media/'):]
    out['recording'] = filename
    out['speaker'] = src['recordedBy']
    return out

def convert_gloss(id_allocator, src):
    out = dict()
    out['gloss_id'] = id_allocator.alloc_next_id()
    out['gloss'] = src.pop('text')
    return out

def convert_category(id_allocator, category):
    out = dict()
    out['category_id'] = id_allocator.alloc_next_id()
    out['category'] = category
    return out

def convert_other_regional_form(id_allocator, regional_form):
    out = dict()
    out['other_regional_form_id'] = id_allocator.alloc_next_id()
    #print('OTHER REG', regional_form['label'])
    out['text'] = regional_form['label']
    return out

def convert_attrs(id_allocator, attrs):
    out = []
    for (k,v) in attrs.items():
        out.append({
            'attr_id': id_allocator.alloc_next_id(),
            'attr': k,
            'value': v
            })
    return out

def ortho_text(id_name, id_allocator, li, sf=None):
    out = []
    if li:
        out.append(ortho_text_record(id_name, id_allocator, 'mm-li', li))
    if sf:
        out.append(ortho_text_record(id_name, id_allocator, 'mm-sf', sf))
    return out

def ortho_text_record(id_name, id_allocator, selector, text):
    return {
        id_name: id_allocator.alloc_next_id(),
        'variant': selector,
        'text': text
    }    

def stripOptSuffix (s, suffix):
    return s[:-len(suffix)] if s.endswith (suffix) else s

def stripOptPrefix (s, prefix):
    return s[len(prefix):] if s.startswith (prefix) else s

if __name__ == "__main__":
    import_legacy_mmo(i_realize_that_this_will_nuke_the_working_mmo_db=True)

# if __name__ == "__main__":
#     if sys.argv[1:] == ['import', '--i_realize_that_this_will_nuke_the_working_mmo_db']:
#         import_legacy_mmo(i_realize_that_this_will_nuke_the_working_mmo_db=True)
#         print('Legacy mmo imported')
#     else:
#         print('Incorrect usage - see the source')

