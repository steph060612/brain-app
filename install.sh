#!/bin/bash
# One-line install: bash ~/Downloads/brain-app/install.sh
exec /bin/bash "$(cd "$(dirname "$0")" && pwd)/scripts/install.sh" "$@"
