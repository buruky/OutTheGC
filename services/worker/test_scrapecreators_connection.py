"""
Connectivity smoke test for ADR 0005 (ScrapeCreators TikTok transcripts) --
confirms the key/billing actually work before building anything on top of
it. Same role as test_openai_connection.py / test_places_connection.py: a
throwaway, one-call check, not the real integration.

API docs: https://docs.scrapecreators.com/v1/tiktok/video/transcript
"""
import os
import sys

import requests
from dotenv import load_dotenv

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

load_dotenv()
api_key = os.environ.get("SCRAPECREATORS_API_KEY")
if not api_key:
    raise SystemExit("SCRAPECREATORS_API_KEY is not set. Check services/worker/.env.")

# A real, public TikTok URL -- reusing one already proven reachable earlier
# in this project's testing (step 10's oEmbed script, same video).
TEST_URL = "https://www.tiktok.com/@showerwithspongebob/video/7351432562931191083"

response = requests.get(
    "https://api.scrapecreators.com/v1/tiktok/video/transcript",
    headers={"x-api-key": api_key},
    params={"url": TEST_URL},
    timeout=15,
)

if response.status_code != 200:
    raise SystemExit(f"FAILED ({response.status_code}): {response.text[:500]}")

data = response.json()
if not data.get("success"):
    raise SystemExit(f"Response came back 200 but success=false: {data}")

transcript = data.get("transcript", "")
print("SUCCESS: received a transcript from the API.")
print(f"Credits charged: {data.get('credits_charged')}, remaining: {data.get('credits_remaining')}")
print(f"Transcript length: {len(transcript)} chars")
print("First 300 chars (raw WebVTT):")
print(transcript[:300])
