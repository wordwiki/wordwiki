#!/bin/bash
set -e
cd $HOME
rsync -av mikmaq@staging.mikmaqonline.org:mmo/database/db.db mmo/database/db.db
rsync -av mikmaq@staging.mikmaqonline.org:mmo/content/ mmo/content/

# Make the pulled production db runnable as the dev db (stops any running
# server, recreates/seeds the user tables, marks the db 'dev', sets djz's
# dev password).  Idempotent; needed until the new version IS production.
cd ~/wordwiki && ./wordwiki.sh post-pull

echo
echo "Pull complete.  Start the server with: ~/wordwiki/wordwiki.sh"
