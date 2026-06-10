set -e
#echo 'BEGIN SWC'

#SCRIPTS=web-build
SCRIPTS=../mmo/scripts

mkdir -p $SCRIPTS

# probably switch to turbopack or similar instead?

cp resources/resource_dir_marker.txt $SCRIPTS
swc compile --config-file .swcrc liminal/*.ts datawiki/*.ts scannedpage/*.ts wordwiki/*.ts --out-dir $SCRIPTS
cp liminal/big.mjs $SCRIPTS/liminal/big.mjs
cp liminal/context-menu.js $SCRIPTS/liminal/context-menu.js

# we replace our sole deno-sqlite 'import' with a an import of a non-functional
# stub when running on client (we don't use sqlite on the client at present,
# but refactoring so that no client imports/code transitively cause this to
# import is too much work or results in awkward code).
# probably should do this with an import map instead of this.
sed -i 's/"..\/..\/deno-sqlite\/mod.js"/"..\/datawiki\/fake-deno-sqlite.js"/g' $SCRIPTS/liminal/db.js
sed -i 's/"https:\/\/deno.land\/x\/sqlite\/mod.ts"/"..\/datawiki\/fake-deno-sqlite.js"/g' $SCRIPTS/liminal/db.js

# deno insists on typscript imports having a .ts extension (for good reasons), and I
# can't figure out how to get SWC to transpile these to .js extensions - so I am doing
# it with 'sed'.  TODO: figure out a better way to do this.
# We rewrite the extension in any relative `from './x.ts'` / `import('./x.ts')`
# specifier (leaving remote https:/jsr: URLs alone), regardless of where it sits on
# the line: SWC sometimes emits an import right after a block-comment close
# (`*/ import ... './x.ts'`), which a line-anchored (^import) rewrite would miss and
# leave a .ts the browser then 404s on.
(cd $SCRIPTS && find . -name "*.js" -exec sed -i -E "s#(from[[:space:]]+['\"]\.[^'\"]*)\.tsx?(['\"])#\1.js\2#g; s#(import\([[:space:]]*['\"]\.[^'\"]*)\.tsx?(['\"])#\1.js\2#g" "{}" ";")


# a way of removing an import that is causing us problems when the
# module loads on the client. XXX MAKE THIS BETTER XXX
sed -i '/REMOVE_FOR_WEB/d' $SCRIPTS/wordwiki/entry-schema.js
sed -i '/REMOVE_FOR_WEB/d' $SCRIPTS/liminal/markup.js

# 'temporal-polyfill' is a bare npm specifier (resolved by deno.json on the
# server); the browser can't resolve it.  Rewrite to the pinned CDN build so
# liminal/date.js is loadable if it ever enters the browser import graph
# (nothing imports it in the browser today, but table.js now imports date.js,
# so this guards the whole graph).
(cd $SCRIPTS && find . -name "*.js" -exec sed -i -E "s#(from[[:space:]]+['\"])temporal-polyfill(['\"])#\1https://esm.sh/temporal-polyfill@0.3.0\2#g" "{}" ";")

rsync -a resources/ ../mmo/resources/

#echo 'END SWC'
