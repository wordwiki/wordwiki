set -e

# Transpile the (only remaining) browser-side TypeScript: the page tagger and
# the public site's page viewer.  Both are fully standalone single files (no
# imports), so none of the old module-graph hackery (fake sqlite, .ts->.js
# import rewriting, REMOVE_FOR_WEB stripping, CDN remapping) is needed any
# more - that all served the retired client-side lexeme editor.

SCRIPTS=../mmo/scripts

mkdir -p $SCRIPTS

cp resources/resource_dir_marker.txt $SCRIPTS
swc compile --config-file .swcrc wordwiki/page-editor.ts wordwiki/page-viewer.ts --out-dir $SCRIPTS

rsync -a resources/ ../mmo/resources/
