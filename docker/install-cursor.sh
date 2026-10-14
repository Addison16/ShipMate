#!/bin/sh
# install-cursor: downloads the official Cursor CLI (cursor-agent) into Shipmate's data folder.
#
# The CLI is about 560 MB (it bundles its own Node), so the image does not ship it; this puts it
# under <cursor home>/cli, which survives image updates. Run it again to update.
#
#   docker exec -it shipmate install-cursor            # the latest version
#   docker exec -it shipmate install-cursor 2026.10.12-d47ca18
#
# It downloads the same package as Cursor's own installer (https://cursor.com/install) and reads
# the latest version from that installer. Nothing is changed in the package.
set -eu

CURSOR_HOME="${SHIPMATE_CURSOR_HOME:-/data/cursor}"
CLI_DIR="$CURSOR_HOME/cli"
VERSION="${1:-${CURSOR_VERSION:-}}"

case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *)
    echo "install-cursor: the Cursor CLI has no build for $(uname -m)." >&2
    exit 1
    ;;
esac

if [ -z "$VERSION" ]; then
  echo "Finding the latest Cursor CLI version..."
  # The official installer names the current package in its download URL.
  VERSION="$(curl -fsSL https://cursor.com/install |
    sed -n 's#.*downloads\.cursor\.com/lab/\([A-Za-z0-9._-]*\)/.*#\1#p' | head -n 1)"
  if [ -z "$VERSION" ]; then
    echo "install-cursor: could not read the latest version from https://cursor.com/install." >&2
    echo "Pass one instead: install-cursor <version>" >&2
    exit 1
  fi
fi
case "$VERSION" in
  *[!A-Za-z0-9._-]* | "")
    echo "install-cursor: '$VERSION' is not a version." >&2
    exit 1
    ;;
esac

URL="https://downloads.cursor.com/lab/$VERSION/linux/$ARCH/agent-cli-package.tar.gz"
FINAL="$CLI_DIR/versions/$VERSION"
mkdir -p "$CLI_DIR/versions"

if [ -x "$FINAL/cursor-agent" ]; then
  echo "Cursor CLI $VERSION is already downloaded."
else
  TMP="$CLI_DIR/versions/.tmp-$VERSION-$$"
  trap 'rm -rf "$TMP"' EXIT
  mkdir -p "$TMP"
  echo "Downloading Cursor CLI $VERSION ($ARCH, about 560 MB)..."
  echo "  $URL"
  if ! curl -fSL --progress-bar "$URL" | tar --strip-components=1 -xzf - -C "$TMP"; then
    echo "install-cursor: the download failed. Check the connection and try again." >&2
    exit 1
  fi
  rm -rf "$FINAL"
  mv "$TMP" "$FINAL"
  trap - EXIT
fi

# Point `current` at this version (swapped in one step, so a running turn keeps its files).
ln -sfn "$VERSION" "$CLI_DIR/versions/.current-$$"
mv -T "$CLI_DIR/versions/.current-$$" "$CLI_DIR/versions/current"

# The command Shipmate and `docker exec` run. It keeps the CLI's login and chats in the cursor
# home rather than the container's own home, which an image update would wipe.
cat >"$CLI_DIR/cursor-agent.new" <<EOF
#!/bin/sh
# Written by install-cursor. Runs the official Cursor CLI with its home in $CURSOR_HOME.
HOME="$CURSOR_HOME"
export HOME
exec "$CLI_DIR/versions/current/cursor-agent" "\$@"
EOF
chmod 0755 "$CLI_DIR/cursor-agent.new"
mv "$CLI_DIR/cursor-agent.new" "$CLI_DIR/cursor-agent"
ln -sf "$CLI_DIR/cursor-agent" /usr/local/bin/cursor-agent 2>/dev/null || true

# Older versions take a lot of room; keep only this one.
for old in "$CLI_DIR"/versions/*; do
  [ "$(basename "$old")" = "$VERSION" ] || [ "$(basename "$old")" = current ] || rm -rf "$old"
done

echo "Installed Cursor CLI $("$CLI_DIR/cursor-agent" --version 2>/dev/null || echo "$VERSION")."
echo "Sign in with: docker exec -it shipmate env NO_OPEN_BROWSER=1 cursor-agent login"
