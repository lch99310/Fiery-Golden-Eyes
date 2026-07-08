#!/bin/bash
# One-time macOS setup for the Fiery-Golden-Eyes weekly auto-updater.
#
#   1. downloads scripts/auto_upload.py to ~/Library/Application Support
#   2. asks for a GitHub token and VERIFIES it works (re-asks if wrong)
#   3. schedules it every Tuesday 10:00 via launchd (no sudo, no password)
#   4. runs it once as a test
#
# Run:
#   curl -fsSL https://raw.githubusercontent.com/lch99310/Fiery-Golden-Eyes/main/scripts/mac_setup.sh | bash
#
# Force a fresh token even if one is stored:
#   curl -fsSL https://raw.githubusercontent.com/lch99310/Fiery-Golden-Eyes/main/scripts/mac_setup.sh | FGE_RESET=1 bash

set -euo pipefail

REPO="lch99310/Fiery-Golden-Eyes"
APP_DIR="$HOME/Library/Application Support/fiery-golden-eyes"
# Fresh config dir (dodges any root-owned ~/.config/fiery-golden-eyes left
# behind by an earlier `sudo` run — the cause of the password loop).
CONF_DIR="$HOME/.fiery-golden-eyes"
TOKEN_FILE="$CONF_DIR/token"
LEGACY_TOKEN="$HOME/.config/fiery-golden-eyes/token"
# Fresh launchd label so a root-owned old plist never blocks us.
PLIST="$HOME/Library/LaunchAgents/com.fiery-golden-eyes.autoupload.plist"
OLD_PLIST="$HOME/Library/LaunchAgents/com.fiery-golden-eyes.weekly.plist"
LOG="$HOME/Library/Logs/fiery-golden-eyes.log"
# Which branch to pull auto_upload.py from (default main). Set FGE_BRANCH to
# test an un-merged branch end-to-end.
BRANCH="${FGE_BRANCH:-main}"
RAW="https://raw.githubusercontent.com/lch99310/Fiery-Golden-Eyes/$BRANCH/scripts"

echo "== Fiery-Golden-Eyes 每週自動更新：一次性設定 =="
mkdir -p "$APP_DIR" "$CONF_DIR" "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"

echo "→ 下載更新腳本…"
curl -fsSL "$RAW/auto_upload.py" -o "$APP_DIR/auto_upload.py"

# ── Token: verify it actually works against GitHub, re-ask if not ──────────
token_works() {
  [ -n "$1" ] || return 1
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $1" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO")
  [ "$code" = "200" ]
}

TOKEN=""
if [ "${FGE_RESET:-0}" != "1" ]; then
  [ -s "$TOKEN_FILE" ] && TOKEN="$(cat "$TOKEN_FILE")"
  [ -z "$TOKEN" ] && [ -s "$LEGACY_TOKEN" ] && TOKEN="$(cat "$LEGACY_TOKEN")"
fi

if [ -n "$TOKEN" ] && token_works "$TOKEN"; then
  echo "→ 已驗證儲存的 token ✓"
else
  [ -n "$TOKEN" ] && echo "→ 儲存的 token 無法使用，需要重新輸入。"
  attempt=1
  while true; do
    echo
    echo "→ 請貼上你的 GitHub token（貼上時畫面「不會」顯示任何字，是正常的；貼完按 Enter）："
    IFS= read -rs TOKEN < /dev/tty
    echo
    if token_works "$TOKEN"; then
      echo "  token 驗證成功 ✓"
      break
    fi
    attempt=$((attempt + 1))
    echo "  ✗ 這個 token 無法存取 $REPO。請確認："
    echo "     • 從 GitHub → Settings → Developer settings → Fine-grained tokens 產生"
    echo "     • Repository access 選到 Fiery-Golden-Eyes"
    echo "     • Permissions → Contents 設為 Read and write"
    if [ "$attempt" -gt 3 ]; then
      echo "  試了幾次都不行，先停下來。確認 token 後再重跑本指令即可。"
      exit 1
    fi
    echo "  再試一次（第 $attempt 次）…"
  done
  printf '%s\n' "$TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "  token 已儲存到 $TOKEN_FILE"
fi

# ── Schedule via launchd (fresh label — no sudo needed) ───────────────────
echo "→ 安裝每週排程（每週二早上 10:00，電腦有開機時執行）…"
launchctl unload "$OLD_PLIST" 2>/dev/null || true   # retire any earlier job

install_cron() {
  local line="0 10 * * 2 /usr/bin/python3 \"$APP_DIR/auto_upload.py\" >> \"$LOG\" 2>&1  # fiery-golden-eyes"
  ( crontab -l 2>/dev/null | grep -v 'fiery-golden-eyes' ; echo "$line" ) | crontab -
  echo "   已用 cron 安裝排程（每週二 10:00）。"
}

if [ -w "$HOME/Library/LaunchAgents" ]; then
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.fiery-golden-eyes.autoupload</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/python3</string>
    <string>$APP_DIR/auto_upload.py</string>
  </array>
  <key>StartCalendarInterval</key><dict>
    <key>Weekday</key><integer>2</integer>
    <key>Hour</key><integer>10</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrPath</key><string>$LOG</string>
</dict></plist>
PLIST
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST" && echo "   已用 launchd 安裝排程（每週二 10:00）。" || install_cron
else
  echo "   （LaunchAgents 資料夾不可寫，改用 cron）"
  install_cron
fi

echo
echo "→ 立刻試跑一次…"
/usr/bin/python3 "$APP_DIR/auto_upload.py" || true

echo
echo "✅ 設定完成！之後每週二早上 10:00（電腦有開機且未休眠時）會自動更新。"
echo "   當週沒跑到也沒關係，下次執行會自動補上漏掉的週。"
echo "   執行紀錄：$LOG"
