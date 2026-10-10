"""
Connectivity smoke test for step 12 (Google Places lookup) -- confirms the
key/billing/restriction setup actually works before building the real
lookup script. Uses one real name+area pulled from step 11's extraction
output (RuRu Shibuya, a real cafe that was correctly extracted in the eval).

Places API (New) Text Search: a POST with a JSON body, not a GET with query
params like the old Places API. X-Goog-FieldMask is required -- it's not
optional metadata, it controls both what comes back AND which Places
pricing tier the call bills under (fewer fields = cheaper tier), so it's
kept to just what step 12 actually needs: id, name, address, coordinates.
"""
import sys
import os

import requests
from dotenv import load_dotenv

# shortcut: same Windows console UTF-8 fix as oembed_caption.py/run_eval.py -- addresses are often non-Latin script.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

load_dotenv()
api_key = os.environ.get("GOOGLE_PLACES_API_KEY")
if not api_key:
    raise SystemExit("GOOGLE_PLACES_API_KEY is not set. Check services/worker/.env.")

response = requests.post(
    "https://places.googleapis.com/v1/places:searchText",
    headers={
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
    },
    json={"textQuery": "RuRu Shibuya, Shibuya, Tokyo, Japan"},
    timeout=10,
)

if response.status_code != 200:
    raise SystemExit(f"FAILED ({response.status_code}): {response.text[:500]}")

places = response.json().get("places", [])
if not places:
    raise SystemExit("SUCCESS (200) but zero places returned -- unexpected for this query.")

top = places[0]
print("SUCCESS: received a response from the API.")
print(f"Name:    {top.get('displayName', {}).get('text')}")
print(f"Address: {top.get('formattedAddress')}")
loc = top.get("location", {})
print(f"Coords:  {loc.get('latitude')}, {loc.get('longitude')}")
