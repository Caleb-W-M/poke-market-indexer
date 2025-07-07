import os, json, requests
from datetime import datetime, timezone
from azure.storage.blob import BlobClient

SET_IDS   = ["sv3", "sv2"]
ACCOUNT   = os.environ["AZURE_STORAGE_ACCOUNT"]
KEY       = os.environ["AZURE_STORAGE_KEY"]
CONTAINER = "indexes"
PKIO      = os.environ["POKEMONTCG_API_KEY"]

def get_top_n_avg_price(set_id: str, n: int = 10):
    url     = "https://api.pokemontcg.io/v2/cards"
    params  = {"q": f"set.id:{set_id}", "pageSize": 250}
    headers = {"X-Api-Key": PKIO}
    prices  = []

    # Fetch all pages
    while url:
        resp = requests.get(url, params=params, headers=headers, timeout=15)
        data = resp.json()
        for card in data.get("data", []):
            # find first available market price
            for finish in card.get("tcgplayer", {}).get("prices", {}).values():
                if finish and finish.get("market"):
                    prices.append(finish["market"])
                    break
        url = data.get("nextPage")

    if not prices:
        return None

    # Sort descending and take the top N
    top_prices = sorted(prices, reverse=True)[:n]
    return round(sum(top_prices) / len(top_prices), 2)


def main():
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for set_id in SET_IDS:
        avg = get_top_n_avg_price(set_id, n=10)
        if avg is None:
            print(f"No prices for {set_id}, skipping")
            continue

        payload = {
            "timestamp": now,
            "set_id":    set_id,
            "index_usd": avg,
            "card_count": len(SET_IDS)
        }

        blob = BlobClient(
            f"https://{ACCOUNT}.blob.core.windows.net",
            container_name=CONTAINER,
            blob_name=f"{set_id}.json",
            credential=KEY
        )
        blob.upload_blob(json.dumps(payload), overwrite=True)
        print(f"Wrote {set_id}.json → {payload}")

if __name__ == "__main__":
    main()
