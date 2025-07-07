import os
import json
import requests
from datetime import datetime, timezone
from azure.storage.blob import BlobClient

# ─── Configuration ──────────────────────────────────────────────────

# Only tracking one set: sv2 = Paldea Evolved
SET_ID = "sv2"

# Environment variables (in your GitHub Actions &/or Cloud Shell)
ACCOUNT = os.environ["AZURE_STORAGE_ACCOUNT"]
KEY     = os.environ["AZURE_STORAGE_KEY"]
PKIO    = os.environ["POKEMONTCG_API_KEY"]

CONTAINER = "indexes"
TOP_N     = 10      # Average the top 10 prices

# ─── Helper to compute the Top-N mean price ─────────────────────────

def get_top_n_avg_price(set_id: str, n: int = TOP_N) -> float | None:
    url     = "https://api.pokemontcg.io/v2/cards"
    params  = {"q": f"set.id:{set_id}", "pageSize": 250}
    headers = {"X-Api-Key": PKIO}
    prices  = []

    # Paginate through all cards
    while url:
        resp = requests.get(url, params=params, headers=headers, timeout=15)
        data = resp.json()
        for card in data.get("data", []):
            # Pick the first market price available
            for finish in card.get("tcgplayer", {}).get("prices", {}).values():
                if finish and finish.get("market"):
                    prices.append(finish["market"])
                    break
        url = data.get("nextPage")

    if not prices:
        return None

    # Sort descending and average the top `n`
    top_prices = sorted(prices, reverse=True)[:n]
    return round(sum(top_prices) / len(top_prices), 2)

# ─── Helper to append a snapshot to your history blob ───────────────

def append_snapshot(set_id: str, snapshot: dict) -> None:
    blob = BlobClient(
        f"https://{ACCOUNT}.blob.core.windows.net",
        container_name=CONTAINER,
        blob_name=f"{set_id}.json",
        credential=KEY
    )
    try:
        existing = blob.download_blob().readall()
        data = json.loads(existing)
        if isinstance(data, list):
            history = data
        elif isinstance(data, dict):
            # Previous runs wrote a single object—wrap it
            history = [data]
        else:
            history = []
    except Exception:
        history = []

    history.append(snapshot)
    # Optionally cap size
    history = history[-500:]

    blob.upload_blob(json.dumps(history), overwrite=True)


# ─── Main entrypoint ─────────────────────────────────────────────────

def main():
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    avg = get_top_n_avg_price(SET_ID)
    if avg is None:
        print(f"No prices found for set {SET_ID} at {now}")
        return

    snapshot = {
        "timestamp": now,
        "index_usd": avg
    }
    append_snapshot(SET_ID, snapshot)
    print(f"Appended snapshot for {SET_ID} at {now}: {avg}")

if __name__ == "__main__":
    main()
