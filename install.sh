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

  # Pin asdf shims to the active Node version so CLIs work inside repos
  # with a different .tool-versions. asdf reshim will wipe these — rerun install.sh after that.
  if [ -d "$HOME/.asdf/shims" ] && command -v asdf >/dev/null 2>&1; then
    NODE_VERSION="$(node --version 2>/dev/null | sed 's/^v//')"
    if [ -n "$NODE_VERSION" ]; then
      BINS="$(node -e "const p=require('$CLI_DIR/package.json');console.log(Object.keys(p.bin||{}).join(' '))" 2>/dev/null || echo "")"
      pinned=0
      for cmd in $BINS; do
        shim="$HOME/.asdf/shims/$cmd"
        [ -f "$shim" ] || continue
        grep -q "ASDF_NODEJS_VERSION" "$shim" && continue
        sed -i.bak "s|^exec asdf exec |exec env ASDF_NODEJS_VERSION=$NODE_VERSION asdf exec |" "$shim"
        rm -f "$shim.bak"
        pinned=$((pinned + 1))
      done
      [ "$pinned" -gt 0 ] && echo "  Pinned $pinned asdf shim(s) to Node $NODE_VERSION"
    fi
  fi
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
