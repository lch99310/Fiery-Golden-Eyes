#!/usr/bin/env python3
"""
Address → coordinate lookup backed by a pre-built G-NAF index.

The VG PSI data carries full postal addresses (number + street + locality)
but no coordinates. G-NAF (Geoscape's Geocoded National Address File,
open data on data.gov.au) maps every Australian address to an exact
lat/lng. build_geocode_index.py condenses the Sydney portion of G-NAF
into data/sydney-address-index.json.gz; this module resolves VG addresses
against it.

Resolution order:
  1. exact street number on the street        (~building precision)
  2. nearest street number on the same street (~street precision)
  3. street centroid                          (~street precision)
  4. caller falls back to suburb-centroid jitter (legacy behaviour)

A small deterministic offset (salted by the full address, ±~15 m) is added
so several units in one building don't stack on a single pixel.
"""

import gzip
import hashlib
import json
import logging
from pathlib import Path

log = logging.getLogger(__name__)

INDEX_FILE = Path(__file__).parent.parent / "data" / "sydney-address-index.json.gz"

_index = None

# Map both G-NAF full street types and common VG abbreviations to one
# canonical abbreviation so the two datasets agree on keys.
STREET_TYPE_ABBREV = {
    "STREET": "ST", "ST": "ST",
    "ROAD": "RD", "RD": "RD",
    "AVENUE": "AVE", "AVE": "AVE", "AV": "AVE",
    "PLACE": "PL", "PL": "PL",
    "DRIVE": "DR", "DR": "DR", "DRV": "DR", "DVE": "DR",
    "CLOSE": "CL", "CL": "CL",
    "COURT": "CT", "CT": "CT",
    "CRESCENT": "CR", "CRES": "CR", "CR": "CR",
    "LANE": "LN", "LN": "LN",
    "PARADE": "PDE", "PDE": "PDE",
    "TERRACE": "TCE", "TCE": "TCE",
    "HIGHWAY": "HWY", "HWY": "HWY",
    "BOULEVARD": "BVD", "BOULEVARDE": "BVD", "BVD": "BVD",
    "CIRCUIT": "CCT", "CCT": "CCT",
    "ESPLANADE": "ESP", "ESP": "ESP",
    "GROVE": "GR", "GR": "GR",
    "SQUARE": "SQ", "SQ": "SQ",
    "PARKWAY": "PKWY", "PKWY": "PKWY", "PWY": "PKWY",
    "GARDENS": "GDNS", "GDNS": "GDNS",
    "CIRCLE": "CIR", "CIR": "CIR",
    "PROMENADE": "PROM", "PROM": "PROM",
    "BROADWAY": "BWY", "BWY": "BWY",
    "PLAZA": "PLZA", "PLZA": "PLZA",
    "ARCADE": "ARC", "ARC": "ARC",
    "ALLEY": "ALY", "ALY": "ALY",
    "GLADE": "GLDE", "GLDE": "GLDE",
    "RIDGE": "RDGE", "RDGE": "RDGE",
    "POINT": "PT", "PT": "PT",
    "MALL": "MALL", "WALK": "WALK", "WAY": "WAY", "RISE": "RISE",
    "GLEN": "GLEN", "MEWS": "MEWS", "ROW": "ROW", "LOOP": "LOOP",
}


def canon_street(street):
    """Canonical street key: 'DEVLIN STREET' and 'Devlin St' → 'DEVLIN ST'."""
    words = street.upper().split()
    if not words:
        return ""
    if words[-1] in STREET_TYPE_ABBREV:
        words[-1] = STREET_TYPE_ABBREV[words[-1]]
    return " ".join(words)


def split_address(address):
    """'507/6 Devlin St' → (number '6', street 'DEVLIN ST').
    The token before the space is unit/number; the house number is the part
    after the slash. Addresses without a leading number return (None, street)."""
    parts = str(address or "").upper().split()
    number = None
    if parts and any(ch.isdigit() for ch in parts[0]) and len(parts) > 1:
        tok = parts.pop(0)
        number = tok.split("/")[-1].strip()
    return number, canon_street(" ".join(parts))


def load_index():
    """Load the index into memory. Returns True if available."""
    global _index
    if _index is not None:
        return True
    if not INDEX_FILE.exists():
        log.info(f"No geocode index at {INDEX_FILE} — using suburb-centroid fallback")
        return False
    with gzip.open(INDEX_FILE, "rt") as f:
        _index = json.load(f)
    log.info(f"Loaded geocode index: {len(_index)} Sydney streets")
    return True


def available():
    return _index is not None


def _salt_offset(salt):
    """Deterministic ±~15 m offset so same-building sales don't stack."""
    h = int(hashlib.md5(str(salt).encode()).hexdigest()[:8], 16)
    dlat = ((h & 0xFFFF) / 0xFFFF - 0.5) * 0.00028
    dlng = (((h >> 16) & 0xFFFF) / 0xFFFF - 0.5) * 0.00028
    return dlat, dlng


def lookup(address, suburb):
    """Resolve an address to (lat, lng), or (None, None) when the street is
    not in the index (caller then falls back to suburb jitter)."""
    if _index is None:
        return None, None

    number, street = split_address(address)
    if not street:
        return None, None
    entry = _index.get(f"{street}|{str(suburb).upper().strip()}")
    if not entry:
        return None, None

    numbers = entry.get("n", {})
    base = None
    if number:
        base = numbers.get(number)
        if base is None:
            digits = "".join(c for c in number if c.isdigit())
            if digits:
                base = numbers.get(digits)
            if base is None and digits:
                # nearest house number on the same street
                target = int(digits)
                best = None
                for k, v in numbers.items():
                    if not k.isdigit():
                        continue
                    dist = abs(int(k) - target)
                    if best is None or dist < best[0]:
                        best = (dist, v)
                if best is not None:
                    base = best[1]
    if base is None:
        base = entry.get("c")
    if base is None:
        return None, None

    dlat, dlng = _salt_offset(address)
    return round(base[0] + dlat, 6), round(base[1] + dlng, 6)
