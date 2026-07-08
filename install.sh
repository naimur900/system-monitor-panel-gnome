#!/bin/bash
# ============================================
# System Monitor Panel — Install Script
# ============================================

set -e

EXTENSION_UUID="system-monitor-panel@naimur"
EXTENSION_DIR="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "╔══════════════════════════════════════════╗"
echo "║  System Monitor Panel — Installer        ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Step 1: Compile GSettings schema
echo "→ Compiling GSettings schema..."
glib-compile-schemas "$SOURCE_DIR/schemas/"
echo "  ✓ Schema compiled successfully"

# Step 2: Create extension directory (or symlink)
if [ -L "$EXTENSION_DIR" ]; then
    echo "→ Removing existing symlink..."
    rm "$EXTENSION_DIR"
elif [ -d "$EXTENSION_DIR" ]; then
    echo "→ Removing existing extension directory..."
    rm -rf "$EXTENSION_DIR"
fi

echo "→ Creating symlink to extension directory..."
mkdir -p "$(dirname "$EXTENSION_DIR")"
ln -s "$SOURCE_DIR" "$EXTENSION_DIR"
echo "  ✓ Symlinked: $SOURCE_DIR → $EXTENSION_DIR"

echo ""
echo "════════════════════════════════════════════"
echo "  Installation complete!"
echo ""
echo "  Enable the extension:"
echo "    gnome-extensions enable $EXTENSION_UUID"
echo ""
echo "  Open preferences:"
echo "    gnome-extensions prefs $EXTENSION_UUID"
echo ""
echo "  View logs:"
echo "    journalctl -f -o cat GNOME_SHELL_EXTENSION_UUID=\$EXTENSION_UUID"
echo ""
echo "  NOTE: You may need to restart GNOME Shell"
echo "  (log out and back in on Wayland)."
echo "════════════════════════════════════════════"
