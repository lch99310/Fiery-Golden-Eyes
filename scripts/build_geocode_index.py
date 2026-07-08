#!/usr/bin/env python3
"""
Build the Sydney address → coordinate index from G-NAF Core.

G-NAF (Geocoded National Address File) is Australia's open dataset mapping
every address to an exact lat/lng, published quarterly on data.gov.au.
This script:

  1. finds the latest "G-NAF Core" ZIP via the data.gov.au CKAN API
     (override with env GNAF_URL if needed),
  2. downloads it (~1.5 GB) and streams the PSV inside,
  3. keeps rows in Greater Sydney postcodes,
  4. writes data/sydney-address-index.json.gz keyed by "STREET ST|LOCALITY"
     with per-house-number coordinates plus a street centroid,
  5. re-geocodes every record in public/data/properties.json.

Runs in GitHub Actions (data.gov.au does not block cloud IPs — unlike the
VG site). Not runnable from networks where data.gov.au is unreachable.
"""

import csv
import gzip
import io
import json
import logging
import os
import sys
import tempfile
import zipfile
from pathlib import Path

import requests

import geocode
from fetch_data import SYDNEY_POSTCODES

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(message)s")
log = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).parent.parent
INDEX_FILE = geocode.INDEX_FILE
PROPERTIES_FILE = REPO_ROOT / "public" / "data" / "properties.json"

CKAN_API = ("https://data.gov.au/api/3/action/package_show"
            "?id=geocoded-national-address-file-g-naf")


def find_gnaf_core_url():
    """Locate the newest G-NAF Core ZIP resource on data.gov.au."""
    override = os.environ.get("GNAF_URL")
    if override:
        log.info(f"Using GNAF_URL override: {override}")
        return override

    r = requests.get(CKAN_API, timeout=60)
    r.raise_for_status()
    resources = r.json()["result"]["resources"]
    candidates = [
        res for res in resources
        if "core" in res.get("name", "").lower()
        and res.get("url", "").lower().endswith(".zip")
    ]
    if not candidates:
        sys.exit("No G-NAF Core ZIP found in the CKAN listing. "
                 "Set env GNAF_URL to the download URL manually.")
    candidates.sort(key=lambda res: res.get("created", ""), reverse=True)
    url = candidates[0]["url"]
    log.info(f"G-NAF Core resource: {candidates[0].get('name')} → {url}")
    return url


def download(url, dest):
    log.info(f"Downloading {url}")
    with requests.get(url, stream=True, timeout=600) as r:
        r.raise_for_status()
        done = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
                done += len(chunk)
                if done % (200 << 20) < (1 << 20):
                    log.info(f"  … {done / 1e9:.1f} GB")
    log.info(f"Downloaded {done / 1e9:.2f} GB")


def build_index(zip_path):
    """Stream the G-NAF Core PSV and build the Sydney street index."""
    index = {}
    rows_kept = 0

    with zipfile.ZipFile(zip_path) as zf:
        psvs = [i for i in zf.infolist() if i.filename.lower().endswith(".psv")]
        if not psvs:
            sys.exit("No .psv file inside the G-NAF ZIP")
        member = max(psvs, key=lambda i: i.file_size)
        log.info(f"Parsing {member.filename} ({member.file_size / 1e9:.2f} GB)")

        with zf.open(member) as raw:
            reader = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8"), delimiter="|")
            required = {"STATE", "POSTCODE", "LATITUDE", "LONGITUDE",
                        "NUMBER_FIRST", "STREET_NAME", "STREET_TYPE", "LOCALITY_NAME"}
            missing = required - set(reader.fieldnames or [])
            if missing:
                sys.exit(f"G-NAF Core header is missing expected columns {sorted(missing)}.\n"
                         f"Actual header: {reader.fieldnames}\n"
                         f"The format may have changed — update build_geocode_index.py.")
            for row in reader:
                if row.get("STATE") != "NSW":
                    continue
                try:
                    if int(row.get("POSTCODE") or 0) not in SYDNEY_POSTCODES:
                        continue
                    lat = round(float(row["LATITUDE"]), 6)
                    lng = round(float(row["LONGITUDE"]), 6)
                except (ValueError, TypeError, KeyError):
                    continue

                street = geocode.canon_street(
                    f"{row.get('STREET_NAME', '')} {row.get('STREET_TYPE', '')}".strip()
                )
                locality = (row.get("LOCALITY_NAME") or "").upper().strip()
                if not street or not locality:
                    continue

                key = f"{street}|{locality}"
                entry = index.setdefault(key, {"n": {}, "_sum": [0.0, 0.0, 0]})
                number = (row.get("NUMBER_FIRST") or "").strip()
                if number and number not in entry["n"]:
                    entry["n"][number] = [lat, lng]
                s = entry["_sum"]
                s[0] += lat; s[1] += lng; s[2] += 1
                rows_kept += 1

    for entry in index.values():
        s = entry.pop("_sum")
        entry["c"] = [round(s[0] / s[2], 6), round(s[1] / s[2], 6)]

    log.info(f"Index: {len(index)} streets from {rows_kept} Sydney address points")
    return index


def regeocode_properties():
    """Re-resolve coordinates for every published property via the new index."""
    if not PROPERTIES_FILE.exists():
        log.warning("No properties.json to re-geocode")
        return
    geocode.load_index()
    d = json.loads(PROPERTIES_FILE.read_text())
    matched = fallback = 0
    for p in d.get("properties", []):
        lat, lng = geocode.lookup(p.get("address"), p.get("suburb"))
        if lat is not None:
            p["lat"], p["lng"] = lat, lng
            matched += 1
        else:
            fallback += 1  # keep existing suburb-jitter position
    PROPERTIES_FILE.write_text(json.dumps(d, separators=(",", ":")))
    total = matched + fallback
    pct = matched / total * 100 if total else 0
    log.info(f"Re-geocoded {matched}/{total} properties precisely ({pct:.1f}%); "
             f"{fallback} kept approximate suburb positions")


def main():
    url = find_gnaf_core_url()
    with tempfile.TemporaryDirectory() as tmp:
        zip_path = Path(tmp) / "gnaf-core.zip"
        download(url, zip_path)
        index = build_index(zip_path)

    INDEX_FILE.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(INDEX_FILE, "wt") as f:
        json.dump(index, f, separators=(",", ":"))
    log.info(f"Wrote {INDEX_FILE} ({INDEX_FILE.stat().st_size / 1e6:.1f} MB)")

    regeocode_properties()


if __name__ == "__main__":
    main()
