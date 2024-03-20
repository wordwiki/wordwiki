set -e
#npm i -g chokidar
cp client.html dist
echo 'BEGIN SWC'
npx swc -d dist/model model/*.ts
npx swc -d dist/templates templates/*.ts templates/*.tsx
npx swc -d dist/utils utils/*.ts
rsync -a utils/big.mjs dist/utils
(cd dist && find . -name "*.js" -exec sed -i 's/[.]tsx\?/.js/g' "{}" ";")
# The sed above is hitting these - thus the constant recopy!!!
# (Removing the -v for now! what we don't know about won't hurt us)
rsync -a model/jswasm/ dist/model/jswasm/
echo 'END SWC'
#npx swc -w -d dist client/main.ts client/worker.ts client/greeter.ts
