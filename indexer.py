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

def get_top_n_cards(set_id: str, n: int = TOP_N):
    url     = "https://api.pokemontcg.io/v2/cards"
    params  = {"q": f"set.id:{set_id}", "pageSize": 250}
    headers = {"X-Api-Key": PKIO}
    cards   = []

    while url:
        resp = requests.get(url, params=params, headers=headers, timeout=15)
        data = resp.json()
        for card in data.get("data", []):
            name = card.get("name")
            # find first market price
            price = None
            for finish in card.get("tcgplayer", {}).get("prices", {}).values():
                if finish and finish.get("market"):
                    price = finish["market"]
                    break
            if price is not None:
                cards.append({"name": name, "price": price})
        url = data.get("nextPage")

    # sort by price descending, take top N
    top = sorted(cards, key=lambda c: c["price"], reverse=True)[:n]
    # compute average
    avg = round(sum(c["price"] for c in top) / len(top), 2) if top else None
    return avg, top

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
    avg, top_cards = get_top_n_cards(SET_ID, n=TOP_N)
    if avg is None:
        print(f"No prices for {SET_ID} at {now}")
        return

    snapshot = {
        "timestamp": now,
        "index_usd": avg,
        "top_cards": top_cards
    }
    append_snapshot(SET_ID, snapshot)
    print(f"Appended {SET_ID}@{now}: {avg} with {len(top_cards)} cards")

if __name__ == "__main__":
    main()
