set -e
#echo 'BEGIN SWC'

#SCRIPTS=web-build
SCRIPTS=../mmo/scripts

mkdir -p $SCRIPTS

# probably switch to turbopack or similar instead?

cp resources/resource_dir_marker.txt $SCRIPTS
swc compile --config-file .swcrc utils/*.ts tagger/*.ts --out-dir $SCRIPTS
cp utils/big.mjs $SCRIPTS/utils/big.mjs
cp utils/context-menu.js $SCRIPTS/utils/context-menu.js

# deno insists on typscript imports having a .ts extension (for good reasons), and I
# can't figure out how to get SWC to transpile these to .js extensions - so I am doing
# it with 'sed'.  TODO: figure out a better way to do this.
(cd $SCRIPTS && find . -name "*.js" -exec sed -i 's/^\(import .*\)[.]tsx\?/\1.js/g' "{}" ";")

# we replace our sole deno-sqlite 'import' with a an import of a non-functional
# stub when running on client (we don't use sqlite on the client at present,
# but refactoring so that no client imports/code transitively cause this to
# import is too much work or results in awkward code).
# probably should do this with an import map instead of this.
sed -i 's/"..\/..\/deno-sqlite\/mod.js"/".\/fake-deno-sqlite.js"/g' $SCRIPTS/tagger/db.js

# a way of removing an import that is causing us problems when the
# module loads on the client. XXX MAKE THIS BETTER XXX
sed -i '/REMOVE_FOR_WEB/d' $SCRIPTS/tagger/entry-schema.js

rsync -a resources/ ../mmo/resources/

#echo 'END SWC'
