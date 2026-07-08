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

# data.gov.au's CKAN instance lives under the /data/ prefix.
# The simplified single-table release ("G-NAF Core" / "Flat File") lives in
# its own dataset; the multi-table full G-NAF lives in the main dataset.
# Try the simple format first, fall back to the full one — build_index()
# detects which format it actually received from the ZIP contents.
CKAN_BASE = "https://data.gov.au/data/api/3/action/package_show?id="
CKAN_DATASETS = [
    "gnaf-flat-file",                          # G-NAF Core / flat file
    "geocoded-national-address-file-g-naf",    # full G-NAF (GDA2020/GDA94)
]


def _ckan_resources(dataset_id):
    try:
        r = requests.get(CKAN_BASE + dataset_id, timeout=60)
        if r.status_code != 200:
            log.warning(f"CKAN {dataset_id} → HTTP {r.status_code}")
            return []
        body = r.json()
        if not body.get("success"):
            log.warning(f"CKAN {dataset_id} → success=false")
            return []
        return body["result"]["resources"]
    except Exception as e:
        log.warning(f"CKAN {dataset_id} failed: {e}")
        return []


def find_gnaf_url():
    """Locate the newest usable G-NAF ZIP (Core preferred, full as fallback)."""
    override = os.environ.get("GNAF_URL")
    if override:
        log.info(f"Using GNAF_URL override: {override}")
        return override

    for dataset_id in CKAN_DATASETS:
        resources = _ckan_resources(dataset_id)
        candidates = [
            res for res in resources
            if res.get("url", "").lower().endswith(".zip")
            and "previous" not in res.get("name", "").lower()
        ]
        if not candidates:
            names = [res.get("name") for res in resources][:10]
            log.warning(f"No ZIP in dataset {dataset_id}; resources: {names}")
            continue
        # Newest first; prefer GDA2020 when both datums are published
        candidates.sort(
            key=lambda res: (res.get("created", ""),
                             "gda2020" in (res.get("name", "") + res.get("url", "")).lower()),
            reverse=True,
        )
        chosen = candidates[0]
        log.info(f"Using resource from {dataset_id}: {chosen.get('name')} → {chosen['url']}")
        return chosen["url"]

    sys.exit("Could not find any G-NAF ZIP via the data.gov.au CKAN API. "
             "Re-run the workflow with the gnaf_url input set to a direct "
             "download URL from https://data.gov.au/data/dataset/geocoded-national-address-file-g-naf")


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


def _add_to_index(index, street, locality, number, lat, lng):
    if not street or not locality:
        return 0
    key = f"{street}|{locality}"
    entry = index.setdefault(key, {"n": {}, "_sum": [0.0, 0.0, 0]})
    if number and number not in entry["n"]:
        entry["n"][number] = [lat, lng]
    s = entry["_sum"]
    s[0] += lat; s[1] += lng; s[2] += 1
    return 1


def _finalize_index(index, rows_kept):
    for entry in index.values():
        s = entry.pop("_sum")
        entry["c"] = [round(s[0] / s[2], 6), round(s[1] / s[2], 6)]
    log.info(f"Index: {len(index)} streets from {rows_kept} Sydney address points")
    return index


def _open_member(zf, member):
    return csv.DictReader(io.TextIOWrapper(zf.open(member), encoding="utf-8"),
                          delimiter="|")


def _parse_core(zf, member):
    """G-NAF Core / flat file: one row per address with lat/lng inline."""
    log.info(f"Parsing Core format: {member.filename} ({member.file_size / 1e9:.2f} GB)")
    index, rows_kept = {}, 0
    reader = _open_member(zf, member)
    required = {"STATE", "POSTCODE", "LATITUDE", "LONGITUDE",
                "NUMBER_FIRST", "STREET_NAME", "STREET_TYPE", "LOCALITY_NAME"}
    missing = required - set(reader.fieldnames or [])
    if missing:
        sys.exit(f"Core PSV header missing {sorted(missing)}.\nActual: {reader.fieldnames}")
    for row in reader:
        if row.get("STATE") != "NSW":
            continue
        try:
            if int(row.get("POSTCODE") or 0) not in SYDNEY_POSTCODES:
                continue
            lat = round(float(row["LATITUDE"]), 6)
            lng = round(float(row["LONGITUDE"]), 6)
        except (ValueError, TypeError):
            continue
        street = geocode.canon_street(
            f"{row.get('STREET_NAME', '')} {row.get('STREET_TYPE', '')}".strip())
        locality = (row.get("LOCALITY_NAME") or "").upper().strip()
        number = (row.get("NUMBER_FIRST") or "").strip()
        rows_kept += _add_to_index(index, street, locality, number, lat, lng)
    return _finalize_index(index, rows_kept)


def _parse_full(zf, members):
    """Full multi-table G-NAF: join NSW locality, street_locality,
    address_detail and address_default_geocode."""
    log.info("Parsing full G-NAF format (NSW table join)")

    localities = {}
    for row in _open_member(zf, members["NSW_LOCALITY_psv.psv"]):
        if not (row.get("DATE_RETIRED") or "").strip():
            localities[row["LOCALITY_PID"]] = (row.get("LOCALITY_NAME") or "").upper().strip()
    log.info(f"  localities: {len(localities)}")

    streets = {}
    for row in _open_member(zf, members["NSW_STREET_LOCALITY_psv.psv"]):
        if (row.get("DATE_RETIRED") or "").strip():
            continue
        name = geocode.canon_street(
            f"{row.get('STREET_NAME', '')} {row.get('STREET_TYPE_CODE', '')}".strip())
        streets[row["STREET_LOCALITY_PID"]] = (name, row.get("LOCALITY_PID"))
    log.info(f"  street-localities: {len(streets)}")

    # Sydney addresses: pid → (house number, street_locality_pid)
    addresses = {}
    for row in _open_member(zf, members["NSW_ADDRESS_DETAIL_psv.psv"]):
        if (row.get("DATE_RETIRED") or "").strip():
            continue
        try:
            if int(row.get("POSTCODE") or 0) not in SYDNEY_POSTCODES:
                continue
        except ValueError:
            continue
        slpid = row.get("STREET_LOCALITY_PID")
        if slpid not in streets:
            continue
        addresses[row["ADDRESS_DETAIL_PID"]] = (
            (row.get("NUMBER_FIRST") or "").strip(), slpid)
    log.info(f"  Sydney addresses: {len(addresses)}")

    index, rows_kept = {}, 0
    for row in _open_member(zf, members["NSW_ADDRESS_DEFAULT_GEOCODE_psv.psv"]):
        addr = addresses.get(row.get("ADDRESS_DETAIL_PID"))
        if addr is None:
            continue
        try:
            lat = round(float(row["LATITUDE"]), 6)
            lng = round(float(row["LONGITUDE"]), 6)
        except (ValueError, TypeError, KeyError):
            continue
        number, slpid = addr
        street, locality_pid = streets[slpid]
        locality = localities.get(locality_pid, "")
        rows_kept += _add_to_index(index, street, locality, number, lat, lng)
    return _finalize_index(index, rows_kept)


FULL_GNAF_TABLES = [
    "NSW_LOCALITY_psv.psv",
    "NSW_STREET_LOCALITY_psv.psv",
    "NSW_ADDRESS_DETAIL_psv.psv",
    "NSW_ADDRESS_DEFAULT_GEOCODE_psv.psv",
]


def build_index(zip_path):
    """Build the Sydney street index; auto-detects Core vs full G-NAF."""
    with zipfile.ZipFile(zip_path) as zf:
        members = {}
        for info in zf.infolist():
            base = os.path.basename(info.filename)
            if base in FULL_GNAF_TABLES:
                members[base] = info

        if len(members) == len(FULL_GNAF_TABLES):
            return _parse_full(zf, members)

        psvs = [i for i in zf.infolist() if i.filename.lower().endswith(".psv")]
        if not psvs:
            sys.exit("No .psv files inside the downloaded ZIP — not a G-NAF archive?")
        return _parse_core(zf, max(psvs, key=lambda i: i.file_size))


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
    url = find_gnaf_url()
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
