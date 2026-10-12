#!/bin/sh
# Builds the plugin and lays out ./plugins/ ready to mount at /app/data/plugins.
# Usage: ./deploy/prepare.sh
set -e
cd "$(dirname "$0")/.."

npm run build

# The mounted volume may leave root-owned files behind; fall back to a
# helper container when the plain rm cannot clean it.
rm -rf deploy/plugins/tmux-configuration 2>/dev/null ||
  docker run --rm -v "$(pwd)/deploy/plugins:/tgt" alpine \
    sh -c "rm -rf /tgt/tmux-configuration"
mkdir -p deploy/plugins/tmux-configuration
cp manifest.json deploy/plugins/tmux-configuration/
cp -r dist deploy/plugins/tmux-configuration/
cp -r locales deploy/plugins/tmux-configuration/
cp -r migrations deploy/plugins/tmux-configuration/
cp README.md LICENSE deploy/plugins/tmux-configuration/ 2>/dev/null || true

echo "deploy/plugins/tmux-configuration is ready — mount deploy/plugins at /app/data/plugins and restart Termix."
