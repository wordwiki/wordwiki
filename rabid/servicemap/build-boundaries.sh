#!/bin/bash
# Regenerate data/kw-fsa.geojson from Statistics Canada's authoritative 2021
# Census FSA boundaries.  Committed output is small (~35 KB) and read at runtime,
# so this only needs to run when the boundaries change or the KW FSA set changes.
#
# Source: StatCan 2021 Cartographic boundary files, FSA layer, served as an
# ArcGIS REST MapServer (queried as GeoJSON in WGS84 - no national shapefile
# download, no reprojection).  Licence: Statistics Canada Open Licence
# (attribution required; carried on the rendered map).
#
# Requires: curl and npx (mapshaper is fetched on demand; no gdal needed).
set -euo pipefail
cd "$(dirname "$0")"

LAYER="https://geo.statcan.gc.ca/geo_wa/rest/services/2021/Cartographic_boundary_files/MapServer/14/query"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# All N2* FSAs (Kitchener-Waterloo-area), WGS84 GeoJSON, FSA code only.
echo "Fetching N2* FSA boundaries from Statistics Canada..."
curl -sS -G "$LAYER" \
  --data-urlencode "where=CFSAUID LIKE 'N2%'" \
  --data-urlencode "outFields=CFSAUID" \
  --data-urlencode "returnGeometry=true" \
  --data-urlencode "outSR=4326" \
  --data-urlencode "f=geojson" \
  -o "$TMP/n2.geojson"

# Drop the one non-KW outlier (N2Z = Kincardine, Bruce County), simplify for a
# small committable asset, round coordinates, keep only the FSA code.
echo "Filtering + simplifying with mapshaper..."
npx -y mapshaper "$TMP/n2.geojson" \
  -filter "CFSAUID != 'N2Z'" \
  -simplify 30% keep-shapes \
  -filter-fields CFSAUID \
  -o precision=0.0001 format=geojson data/kw-fsa.geojson

echo "Wrote data/kw-fsa.geojson ($(wc -c < data/kw-fsa.geojson) bytes,\
 $(grep -o CFSAUID data/kw-fsa.geojson | wc -l) FSAs)"
