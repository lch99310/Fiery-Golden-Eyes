#!/usr/bin/env python3
"""
Weekly auto-uploader for Fiery-Golden-Eyes — runs on YOUR computer.

The NSW Valuer General site blocks cloud/datacenter IPs, so CI can never
download the data. This script runs from a home connection instead: it
downloads the latest weekly PSI ZIP(s) and uploads them to the repo's
data-inbox/ folder via the GitHub API. The repo's Actions pipeline then
parses the files and deploys the site automatically.

- Uses only the Python 3.9+ standard library (no pip installs).
- Catches up automatically: checks the last few Mondays and uploads any
  week not uploaded before, so a skipped week (computer off) heals itself.
- Re-uploading the same week is harmless — the pipeline dedupes by sale ID.

Setup on macOS is automated by scripts/mac_setup.sh (see README).
"""

import base64
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

REPO = "lch99310/Fiery-Golden-Eyes"
VG_WEEKLY_URL = "https://www.valuergeneral.nsw.gov.au/_psi/weekly/{d}.zip"
CATCH_UP_WEEKS = 6

# Primary config dir; the legacy ~/.config path is still read for tokens
# saved by older setups.
CONF_DIR = Path.home() / ".fiery-golden-eyes"
LEGACY_CONF_DIR = Path.home() / ".config" / "fiery-golden-eyes"
TOKEN_FILE = CONF_DIR / "token"
STATE_FILE = CONF_DIR / "uploaded_weeks.txt"


def read_token():
    for path in (TOKEN_FILE, LEGACY_CONF_DIR / "token"):
        if path.exists() and path.read_text().strip():
            return path.read_text().strip()
    return None

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "*/*",
    "Accept-Language": "en-AU,en;q=0.9",
    "Referer": "https://www.valuergeneral.nsw.gov.au/",
}


def log(msg):
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S}  {msg}", flush=True)


def recent_mondays(n):
    """Dates (YYYYMMDD) of the last n Mondays in Sydney time, oldest first.
    VG publishes each weekly file on Monday, named after that Monday."""
    today_syd = datetime.now(ZoneInfo("Australia/Sydney")).date()
    last_monday = today_syd - timedelta(days=today_syd.weekday())
    return [
        (last_monday - timedelta(weeks=i)).strftime("%Y%m%d")
        for i in range(n)
    ][::-1]


def download_week(dstr):
    """Download one weekly ZIP. Returns bytes, or None if not published yet."""
    url = VG_WEEKLY_URL.format(d=dstr)
    req = urllib.request.Request(url, headers=BROWSER_HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def gh_request(method, path, token, body=None):
    req = urllib.request.Request(
        "https://api.github.com" + path,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "fiery-golden-eyes-auto-upload",
        },
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            info = json.loads(e.read() or b"{}")
        except json.JSONDecodeError:
            info = {}
        return e.code, info


def upload_to_inbox(token, dstr, blob):
    """Upload the ZIP to data-inbox/<date>.zip on main via the contents API."""
    path = f"/repos/{REPO}/contents/data-inbox/{dstr}.zip"
    body = {
        "message": f"data: upload VG weekly {dstr}",
        "content": base64.b64encode(blob).decode(),
        "branch": "main",
    }
    # If the same file already exists (earlier upload not yet processed),
    # the API requires its blob SHA to overwrite it.
    status, info = gh_request("GET", path + "?ref=main", token)
    if status == 200 and isinstance(info, dict) and info.get("sha"):
        body["sha"] = info["sha"]

    status, info = gh_request("PUT", path, token, body)
    if status in (200, 201):
        return True
    log(f"ERROR uploading {dstr}: HTTP {status} — {info.get('message', 'unknown error')}")
    if status == 401:
        log("Your GitHub token seems invalid or expired. "
            "Create a new one and run mac_setup.sh again.")
    return False


def main():
    token = read_token()
    if not token:
        sys.exit(f"No GitHub token found at {TOKEN_FILE} — run mac_setup.sh first.")

    CONF_DIR.mkdir(parents=True, exist_ok=True)
    state_file = STATE_FILE if STATE_FILE.exists() else (
        LEGACY_CONF_DIR / "uploaded_weeks.txt")
    done = set(state_file.read_text().split()) if state_file.exists() else set()
    uploaded = 0

    for dstr in recent_mondays(CATCH_UP_WEEKS):
        if dstr in done:
            continue
        log(f"Downloading VG weekly {dstr} …")
        try:
            blob = download_week(dstr)
        except Exception as e:
            log(f"ERROR downloading {dstr}: {e}")
            continue
        if blob is None:
            log(f"  {dstr} not published yet — skipping")
            continue

        log(f"  got {len(blob) / 1e6:.1f} MB, uploading to GitHub …")
        if upload_to_inbox(token, dstr, blob):
            done.add(dstr)
            uploaded += 1
            CONF_DIR.mkdir(parents=True, exist_ok=True)
            STATE_FILE.write_text("\n".join(sorted(done)[-20:]) + "\n")
            log(f"  ✅ {dstr} uploaded — the site will update itself in a few minutes")

    if uploaded == 0:
        log("Nothing new to upload this run.")


if __name__ == "__main__":
    main()
