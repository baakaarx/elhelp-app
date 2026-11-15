#!/usr/bin/env bash
# Convenience wrapper: the build itself lives in scripts/build-apk.mjs so Windows, macOS and
# Linux all run the exact same steps.
#
#   ./scripts/build-apk.sh http://55.0.55.70:3000
#   ./scripts/build-apk.sh https://tracking.company.com --clean
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/build-apk.mjs" "$@"
