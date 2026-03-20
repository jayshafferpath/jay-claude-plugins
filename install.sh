#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMMANDS_DIR="$HOME/.claude/commands"

mkdir -p "$COMMANDS_DIR"

echo "Installing claude-queue commands..."

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

echo "Done. Commands available:"
echo "  /jay-claude-queue  - Run all phases"
echo "  /jay-queue-plan    - Phase 1: Plan ready tickets"
echo "  /jay-queue-execute - Phase 2: Execute approved plans"
echo "  /jay-queue-promote - Phase 3: Promote finished tickets"
