#!/usr/bin/env bash
# Installs Studio's shared memory: one basic-memory MCP server (studio-memory.service, loopback only) used by
# Claude Code, Codex and Studio's DeepSeek. Idempotent and user-space only (no sudo). Every config file it
# changes is backed up first (<file>.bak-studio-memory-<time>) and other entries are kept. See docs/memory.md.
#
# Run it from the repository root:  bash scripts/wsl/install-memory.sh
# Optional overrides: STUDIO_MEMORY_PORT (8770), STUDIO_MEMORY_PROJECT (studio),
# STUDIO_MEMORY_HOME (~/studio-memory), STUDIO_MEMORY_BASIC_MEMORY_VERSION (0.23.2).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME=studio-memory
PORT="${STUDIO_MEMORY_PORT:-8770}"
PROJECT="${STUDIO_MEMORY_PROJECT:-studio}"
NOTES="${STUDIO_MEMORY_HOME:-$HOME/studio-memory}"
VERSION="${STUDIO_MEMORY_BASIC_MEMORY_VERSION:-0.23.2}"
URL="http://127.0.0.1:$PORT/mcp"
STAMP="$(date +%Y%m%d-%H%M%S)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/$NAME.service"
BEGIN_MARK="<!-- studio-memory:begin -->"
END_MARK="<!-- studio-memory:end -->"
export PATH="$HOME/.local/bin:$PATH"
export BASIC_MEMORY_NO_PROMOS=1

say() { printf '\n==> %s\n' "$*"; }
# Copies a file next to itself (once per run) before this script changes it.
backup() {
  if [ -f "$1" ] && [ ! -f "$1.bak-$NAME-$STAMP" ]; then
    cp -p "$1" "$1.bak-$NAME-$STAMP"
    echo "    backup: $1.bak-$NAME-$STAMP"
  fi
}
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }

case "$PORT" in ''|*[!0-9]*) echo "STUDIO_MEMORY_PORT must be a number" >&2; exit 1 ;; esac
case "$PROJECT" in ''|*[!A-Za-z0-9_-]*) echo "STUDIO_MEMORY_PROJECT may only use letters, digits, - and _" >&2; exit 1 ;; esac

# ── 1. uv and basic-memory ────────────────────────────────────────────────────
if ! command -v uv >/dev/null 2>&1; then
  say "Installing uv (official Astral installer, user space)"
  curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh
fi
if ! command -v basic-memory >/dev/null 2>&1; then
  say "Installing basic-memory $VERSION with uv"
  # 0.23 depends on a FastMCP pre-release, hence --prerelease=allow (upstream install instructions).
  uv tool install "basic-memory==$VERSION" --prerelease=allow
fi
BM="$(command -v basic-memory)"
say "$("$BM" --version 2>/dev/null | tail -n 1)"

# ── 2. The shared project ─────────────────────────────────────────────────────
# Read from config.json rather than the CLI's table output, which is meant for people.
project_path() {
  python3 - "$PROJECT" <<'PY'
import json, os, sys
try:
    config = json.load(open(os.path.expanduser("~/.basic-memory/config.json")))
except (OSError, ValueError):
    sys.exit(0)
entry = (config.get("projects") or {}).get(sys.argv[1])
print(entry.get("path", "") if isinstance(entry, dict) else (entry or ""))
PY
}
# Settings only applied when the project is first created, so a later deliberate change survives reruns.
if [ -z "$(project_path)" ]; then
  say "Creating project '$PROJECT' in $NOTES"
  mkdir -p "$NOTES"
  "$BM" project add "$PROJECT" "$NOTES" --default
  # The bundled embedding model is English-only and downloaded on first use; full-text search is enough here.
  "$BM" config set semantic_search_enabled false >/dev/null
else
  echo "    project '$PROJECT' already exists at $(project_path)"
fi
# The service must not change underneath its clients, and it never needs the cloud upsell.
"$BM" config set auto_update false >/dev/null
"$BM" config set cloud_promo_opt_out true >/dev/null

# ── 3. One shared server: systemd --user, 127.0.0.1 only ──────────────────────
say "Installing $UNIT"
mkdir -p "$UNIT_DIR"
RENDERED="$(mktemp)"
trap 'rm -f "$RENDERED"' EXIT
sed -e "s#__BASIC_MEMORY__#$BM#g" -e "s#__PORT__#$PORT#g" -e "s#__PROJECT__#$PROJECT#g" \
  "$ROOT/scripts/wsl/$NAME.service" > "$RENDERED"
CHANGED=0
if ! cmp -s "$RENDERED" "$UNIT" 2>/dev/null; then
  backup "$UNIT"
  cp "$RENDERED" "$UNIT"
  CHANGED=1
fi
systemctl --user daemon-reload
if ! systemctl --user is-active --quiet "$NAME.service" && port_open; then
  echo "Port $PORT is already used by another program. Set STUDIO_MEMORY_PORT and rerun." >&2
  exit 1
fi
systemctl --user enable "$NAME.service" >/dev/null 2>&1
if [ "$CHANGED" = 1 ]; then systemctl --user restart "$NAME.service"; else systemctl --user start "$NAME.service"; fi
for _ in $(seq 1 30); do port_open && break; sleep 1; done
if port_open; then echo "    $NAME is listening on $URL"; else
  echo "    $NAME did not open port $PORT; see: journalctl --user -u $NAME -n 50" >&2
  exit 1
fi

# ── 4. Claude Code (user scope, streamable HTTP) ──────────────────────────────
say "Registering $NAME with Claude Code (user scope)"
claude_state() {
  python3 - "$NAME" "$URL" <<'PY'
import json, os, sys
try:
    servers = json.load(open(os.path.expanduser("~/.claude.json"))).get("mcpServers") or {}
except (OSError, ValueError):
    servers = {}
entry = servers.get(sys.argv[1])
print("missing" if entry is None else "ok" if entry.get("type") == "http" and entry.get("url") == sys.argv[2] else "different")
PY
}
if ! command -v claude >/dev/null 2>&1; then
  echo "    claude is not installed; skipped"
else
  STATE="$(claude_state)"
  if [ "$STATE" = ok ]; then echo "    already registered"; else
    backup "$HOME/.claude.json"
    [ "$STATE" = different ] && claude mcp remove "$NAME" -s user >/dev/null
    claude mcp add -s user -t http "$NAME" "$URL" >/dev/null
    echo "    registered ($(claude_state))"
  fi
fi

# ── 5. Codex (~/.codex/config.toml, streamable HTTP) ──────────────────────────
say "Registering $NAME with Codex"
codex_state() {
  python3 - "$NAME" "$URL" <<'PY'
import os, re, sys
path = os.path.expanduser("~/.codex/config.toml")
try:
    raw = open(path, "rb").read()
except OSError:
    raw = b""
try:
    import tomllib
    entry = (tomllib.loads(raw.decode("utf-8")).get("mcp_servers") or {}).get(sys.argv[1])
except ImportError:
    # Python < 3.11: a plain look at the table header and its url line is enough for this check.
    text = raw.decode("utf-8", "replace")
    match = re.search(r'^\[mcp_servers\.(?:"%s"|%s)\]\s*$(.*?)(?=^\[|\Z)' % ((re.escape(sys.argv[1]),) * 2), text, re.M | re.S)
    url = re.search(r'^\s*url\s*=\s*"([^"]*)"', match.group(1), re.M) if match else None
    entry = None if not match else {"url": url.group(1) if url else None}
except ValueError:
    entry = None
print("missing" if entry is None else "ok" if entry.get("url") == sys.argv[2] else "different")
PY
}
if ! command -v codex >/dev/null 2>&1; then
  echo "    codex is not installed; skipped"
else
  STATE="$(codex_state)"
  if [ "$STATE" = ok ]; then echo "    already registered"; else
    backup "$HOME/.codex/config.toml"
    [ "$STATE" = different ] && codex mcp remove "$NAME" >/dev/null
    codex mcp add "$NAME" --url "$URL" >/dev/null
    echo "    registered ($(codex_state))"
  fi
fi

# ── 6. Conventions so the models actually use it ──────────────────────────────
CONVENTIONS="$BEGIN_MARK
## 共享记忆（studio-memory）

Claude Code、Codex 和 Studio 里的 DeepSeek 共用一个 basic-memory 记忆库（MCP 服务 \`$NAME\`）。
- 开始处理某个项目前，先用 \`search_notes\` 搜索该项目的文件夹和 \`global\`，读相关笔记再动手。
- 把持久的事实、决定和偏好写成笔记（\`write_note\`）：项目相关放在以项目目录名（小写）命名的文件夹，
  如 \`agent-cloud-studio\`；跨项目的放 \`global\`。同一主题先搜索，优先更新已有笔记，不要重复新建。
- tags 写上你自己（\`claude\` 或 \`codex\`），方便看出是谁记的。
- 中文笔记末尾加一行 \`关键词：\` 和 3–8 个用空格分隔的词——全文检索按空格分词。
- 绝不保存密钥、令牌、密码、私钥或任何凭据，也不记临时状态或大段代码。
- 记忆服务连不上时照常工作，不要反复重试。
$END_MARK"

# Replaces the delimited block in place, or appends it; existing content outside the markers is kept.
install_conventions() {
  local file="$1"
  mkdir -p "$(dirname "$file")"
  local result
  result="$(CONVENTIONS="$CONVENTIONS" python3 - "$file" "$BEGIN_MARK" "$END_MARK" <<'PY'
import os, sys
path, begin, end = sys.argv[1], sys.argv[2], sys.argv[3]
block = os.environ["CONVENTIONS"]
try:
    text = open(path, encoding="utf-8").read()
except FileNotFoundError:
    text = ""
start, stop = text.find(begin), text.find(end)
if start != -1 and stop != -1 and stop > start:
    updated = text[:start] + block + text[stop + len(end):]
else:
    updated = (text.rstrip("\n") + "\n\n" if text.strip() else "") + block + "\n"
if updated == text:
    print("unchanged")
else:
    print("changed")
    with open(path + ".studio-memory-new", "w", encoding="utf-8") as handle:
        handle.write(updated)
PY
)"
  if [ "$result" = changed ]; then
    backup "$file"
    mv "$file.studio-memory-new" "$file"
    echo "    updated $file"
  else
    echo "    $file already up to date"
  fi
}
say "Writing conventions"
install_conventions "$HOME/.claude/CLAUDE.md"
install_conventions "$HOME/.codex/AGENTS.md"

say "Done. Notes live in $(project_path); the server answers on $URL."
echo "    Restart running Claude Code / Codex sessions to pick up the new MCP server."
echo "    Studio's DeepSeek bridge uses STUDIO_MEMORY_URL (default $URL)."
