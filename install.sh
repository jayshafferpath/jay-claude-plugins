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

# Install agents
AGENTS_DIR="$HOME/.claude/agents"
mkdir -p "$AGENTS_DIR"

echo ""
echo "Installing agents..."

for agent in "$SCRIPT_DIR"/agents/*.md; do
  [ -f "$agent" ] || continue
  name=$(basename "$agent")
  target="$AGENTS_DIR/$name"

  if [ -L "$target" ]; then
    rm "$target"
  elif [ -f "$target" ]; then
    echo "  Backing up existing $name -> $name.bak"
    mv "$target" "$target.bak"
  fi

  ln -s "$agent" "$target"
  echo "  Linked $name"
done

# Create .env from example if not present (project-level)
if [ ! -f "$SCRIPT_DIR/.env" ] && [ -f "$SCRIPT_DIR/.env.example" ]; then
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  echo "  Created .env from template — fill in your credentials"
fi

# Create ~/.claude/.env for machine-level config if not present
MACHINE_ENV="$HOME/.claude/.env"
if [ ! -f "$MACHINE_ENV" ]; then
  cat > "$MACHINE_ENV" <<'EOF'
# Machine-level config (shared across all projects using jay-claude-plugins)
# DEV_ROOT=/path/to/your/dev/directory
# SLACK_WEBHOOK_URL=
EOF
  echo "  Created $MACHINE_ENV — set DEV_ROOT to your dev directory"
fi

# Install CLI tools
CLI_DIR="$SCRIPT_DIR/cli"
if [ -d "$CLI_DIR" ]; then
  echo ""
  echo "Installing CLI tools..."
  (cd "$CLI_DIR" && npm install --silent)
  npm link --silent "$CLI_DIR" 2>/dev/null || {
    echo "  Note: 'npm link' failed — you can run directly with: node $CLI_DIR/bin/ticket-status.js"
  }
  echo "  ticket-status CLI installed"
fi

echo ""
echo "Done. Commands available:"
echo "  /ticket-work       - Run tickets end-to-end (single or queue mode)"
echo "  /ticket-status     - Claude command: ticket status (also available as CLI)"
echo "  /stack-rebase      - Rebase a stacked PR chain"
echo "  /ears-requirements - EARS requirements ideation"
echo ""
echo "Agents available:"
echo "  @planner           - Decompose Confluence docs into Gherkin-based Jira backlog"
echo "  @refactor          - CRAP/DRY analysis and refactoring implementation"
echo ""
echo "CLI tools:"
echo "  ticket-status      - View/manage ticket stacks (run directly in terminal)"
echo ""
echo "Next steps:"
echo "  1. Edit .env — set JIRA_EMAIL, JIRA_API_TOKEN, JIRA_DOMAIN"
echo "  2. Edit ~/.claude/.env — set DEV_ROOT to your dev directory"
