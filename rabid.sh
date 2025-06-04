#/bin/bash
set -e
deno run --check --allow-all rabid/rabid.ts serve
#curl localhost:8888/rabid/user

