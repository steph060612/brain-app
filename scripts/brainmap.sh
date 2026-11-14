#!/bin/bash
# brainmap: read-only answers about a JavaScript project linked and mapped in the Brain app.
# Installed by install.sh, which fills in the two paths below. Run `brainmap help` for the commands.
exec "__NODE__" "__APP_DIR__/src/brainmap.js" "$@"
