#!/bin/sh
set -eu
cd /app
DUCK_UI_ENV_DIR=/app/dist bun inject-env.js
bun /lakehouse/patch.js
exec ./node_modules/.bin/serve -s dist -l 5522 -c /app/serve.json
