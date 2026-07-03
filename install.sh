#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Nori Code — one-command installer (macOS / Linux)
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

NORI_DIR="${NORI_HOME:-$HOME/.nori-code}"
REPO="${NORI_REPO:-https://github.com/wangyuahn/nori-code.git}"

echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║       Nori Code Installer           ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""

# ---- check Node.js ----
if ! command -v node &>/dev/null; then
    echo -e "${RED}Node.js is required but not found.${NC}"
    echo "Install Node.js >= 24.15.0 from https://nodejs.org"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 24 ]; then
    echo -e "${RED}Node.js >= 24.15.0 required. Current: $(node -v)${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Node.js $(node -v)${NC}"

# ---- check pnpm ----
if ! command -v pnpm &>/dev/null; then
    echo "Installing pnpm..."
    npm install -g pnpm
fi
echo -e "${GREEN}✓ pnpm $(pnpm -v)${NC}"

# ---- clone / update ----
if [ -d "$NORI_DIR/.git" ]; then
    echo "Updating nori-code..."
    cd "$NORI_DIR"
    git pull --ff-only
else
    echo "Cloning nori-code into $NORI_DIR..."
    git clone "$REPO" "$NORI_DIR"
    cd "$NORI_DIR"
fi

# ---- install & build ----
echo "Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

echo "Building..."
pnpm -C apps/nori-code run build

# ---- create global symlink ----
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
NORI_BIN="$BIN_DIR/nori"

cat > "$NORI_BIN" << EOF
#!/usr/bin/env bash
exec node "$NORI_DIR/apps/nori-code/dist/main.mjs" "\$@"
EOF
chmod +x "$NORI_BIN"

# ---- add to PATH ----
SHELL_RC=""
case "$SHELL" in
    */zsh)  SHELL_RC="$HOME/.zshrc" ;;
    */bash) SHELL_RC="$HOME/.bashrc" ;;
    */fish) SHELL_RC="$HOME/.config/fish/config.fish" ;;
    *)      SHELL_RC="$HOME/.profile" ;;
esac

if ! echo "$PATH" | grep -q "$BIN_DIR"; then
    echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$SHELL_RC"
    echo -e "${GREEN}Added $BIN_DIR to PATH in $SHELL_RC${NC}"
fi

echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Nori Code installed!              ║${NC}"
echo -e "${GREEN}║   Run: nori                         ║${NC}"
echo -e "${GREEN}║   Or:  source $SHELL_RC && nori     ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
