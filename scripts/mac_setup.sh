#!/bin/bash
# One-time macOS setup for the Fiery-Golden-Eyes weekly auto-updater.
#
# What it does:
#   1. Downloads scripts/auto_upload.py to ~/Library/Application Support
#   2. Asks for your GitHub token (stored privately in ~/.config)
#   3. Installs a launchd schedule: every Tuesday 10:00 (local time)
#   4. Runs the updater once immediately as a test
#
# Run it with:
#   curl -fsSL https://raw.githubusercontent.com/lch99310/Fiery-Golden-Eyes/main/scripts/mac_setup.sh | bash

set -euo pipefail

APP_DIR="$HOME/Library/Application Support/fiery-golden-eyes"
CONF_DIR="$HOME/.config/fiery-golden-eyes"
PLIST="$HOME/Library/LaunchAgents/com.fiery-golden-eyes.weekly.plist"
LOG="$HOME/Library/Logs/fiery-golden-eyes.log"
RAW_SCRIPT="https://raw.githubusercontent.com/lch99310/Fiery-Golden-Eyes/main/scripts/auto_upload.py"

echo "== Fiery-Golden-Eyes 每週自動更新：一次性設定 =="
mkdir -p "$APP_DIR" "$CONF_DIR" "$HOME/Library/LaunchAgents"

echo "→ 下載更新腳本…"
curl -fsSL "$RAW_SCRIPT" -o "$APP_DIR/auto_upload.py"

if [ ! -s "$CONF_DIR/token" ]; then
  echo
  echo "→ 請貼上你的 GitHub token（輸入不會顯示在畫面上，貼上後按 Enter）："
  read -rs TOKEN < /dev/tty
  echo
  printf '%s\n' "$TOKEN" > "$CONF_DIR/token"
  chmod 600 "$CONF_DIR/token"
  echo "  token 已儲存到 $CONF_DIR/token"
else
  echo "→ 已有儲存的 token，沿用。（想換 token：刪除 $CONF_DIR/token 後重跑本設定）"
fi

echo "→ 安裝每週排程（每週二早上 10:00，電腦有開機時執行）…"

# A root-owned plist or LaunchAgents dir (usually from a previous sudo run)
# blocks the launchd path. Fall back to a user crontab in that case —
# crontab needs no elevated permissions at all.
if { [ -e "$PLIST" ] && [ ! -w "$PLIST" ]; } || [ ! -w "$HOME/Library/LaunchAgents" ]; then
  echo "   （launchd 排程檔權限不對，改用 cron——效果相同，不需要密碼）"
  CRON_LINE="0 10 * * 2 /usr/bin/python3 \"$APP_DIR/auto_upload.py\" >> \"$LOG\" 2>&1  # fiery-golden-eyes"
  ( crontab -l 2>/dev/null | grep -v 'fiery-golden-eyes' ; echo "$CRON_LINE" ) | crontab -
  echo "   cron 排程已安裝（每週二 10:00）。"

  echo
  echo "→ 立刻試跑一次…"
  /usr/bin/python3 "$APP_DIR/auto_upload.py"
  echo
  echo "✅ 設定完成！之後每週二早上 10:00（電腦有開機且未休眠時）會自動更新。"
  echo "   當週沒跑到也沒關係，下次執行會自動補上漏掉的週。"
  echo "   執行紀錄：$LOG"
  exit 0
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.fiery-golden-eyes.weekly</string>
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
launchctl load "$PLIST"

echo
echo "→ 立刻試跑一次…"
/usr/bin/python3 "$APP_DIR/auto_upload.py"

echo
echo "✅ 設定完成！之後每週二早上 10:00 會自動下載並上傳最新資料。"
echo "   當週電腦沒開機也沒關係，下次執行會自動補上漏掉的週。"
echo "   執行紀錄：$LOG"
