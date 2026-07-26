"""GitHub Actions: fetch DoCode data → data/latest.json"""
import json, os, time, sys
from urllib.request import Request, urlopen
from urllib.error import HTTPError

TOKEN = os.environ.get("DOCODE_TOKEN", "")
USER_ID = os.environ.get("DOCODE_USER_ID", "")
BASE = "https://docode.cc"

def api(path):
    url = BASE + path
    req = Request(url, headers={
        "Authorization": f"Bearer {TOKEN}",
        "New-Api-User": USER_ID,
        "Accept": "application/json",
    })
    with urlopen(req, timeout=25) as resp:
        return json.loads(resp.read())

def main():
    print(f"Fetching DoCode data (user_id={USER_ID})...")

    # 1. User info
    user = api("/api/user/self")
    u = user.get("data", {})
    print(f"  User: {u.get('username')} | quota: {u.get('quota',0)/500000:.2f}")

    # 2. Logs (last 30 days)
    from_ts = int(time.time()) - 30 * 86400
    all_logs = []
    for page in range(20):
        qs = f"?p={page}&page_size=100&type=2&start_timestamp={from_ts}"
        j = api("/api/log/self" + qs)
        d = j.get("data", {})
        items = d.get("items", [])
        all_logs.extend(items)
        total = d.get("total", 0)
        print(f"  Page {page}: {len(items)} items (total={total})")
        if len(items) < 100 or (page + 1) * 100 >= total:
            break

    # 3. Write output
    os.makedirs("data", exist_ok=True)
    output = {
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "station": "DoCode",
        "user": u,
        "logs": all_logs,
        "log_count": len(all_logs),
    }
    with open("data/latest.json", "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"Done! Wrote {len(all_logs)} log entries.")

if __name__ == "__main__":
    main()
