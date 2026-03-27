#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMMANDS_DIR="$HOME/.claude/commands"

mkdir -p "$COMMANDS_DIR"

echo "Installing commands..."

for cmd in "$SCRIPT_DIR"/commands/*.md; do
  name=$(basename "$cmd")
  target="$COMMANDS_DIR/$name"

  if [ -L "$target" ]; then
    rm "$target"
  elif [ -f "$target" ]; then
    echo "  Backing up existing $name -> $name.bak"
    mv "$target" "$target.bak"
  fi

  ln -s "$cmd" "$target"
  echo "  Linked $name"
done

# Install dev-root.json config
DEV_ROOT_SRC="$SCRIPT_DIR/dev-root.json"
DEV_ROOT_TARGET="$HOME/.claude/dev-root.json"
if [ -f "$DEV_ROOT_SRC" ]; then
  if [ -f "$DEV_ROOT_TARGET" ] && [ ! -L "$DEV_ROOT_TARGET" ]; then
    echo "  dev-root.json already exists at $DEV_ROOT_TARGET, skipping"
    echo "  Edit $DEV_ROOT_TARGET to set your dev directory"
  else
    [ -L "$DEV_ROOT_TARGET" ] && rm "$DEV_ROOT_TARGET"
    cp "$DEV_ROOT_SRC" "$DEV_ROOT_TARGET"
    echo "  Copied dev-root.json (edit ~/.claude/dev-root.json to set your dev directory)"
  fi
fi

echo ""
echo "Done. Commands available:"
echo "  /ticket-work       - Run tickets end-to-end (single or queue mode)"
echo "  /stack-rebase      - Rebase a stacked PR chain"
echo "  /ears-requirements - EARS requirements ideation"
echo ""
echo "Configure your dev directory in ~/.claude/dev-root.json"
