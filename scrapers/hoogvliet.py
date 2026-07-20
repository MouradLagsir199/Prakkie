"""Hoogvliet full catalog scraper.

Hoogvliet's storefront uses the public Tweakwise Navigator feed for product
listing.  The Intershop batch endpoint then adds stock, regular price, exact
category hierarchy and packaging.  Hoogvliet does not publish an EAN in either
response; this is kept as an honest gap so these rows are never auto-matched.

Usage:
    python -m scrapers.hoogvliet
    python -m scrapers.hoogvliet --limit 50
    python -m scrapers.hoogvliet --limit 50 --no-detail
"""

from __future__ import annotations

import argparse
import asyncio
import html
import re
from typing import Any

import httpx

from .common import JsonlWriter, backoff_sleep, default_output_path, now_iso, should_retry

STORE = "hoogvliet"
INSTANCE_KEY = "ed681b01"
NAVIGATION_URL = f"https://gateway.tweakwisenavigator.com/navigation/{INSTANCE_KEY}"
HOME_URL = "https://www.hoogvliet.com/"
ROOT_CATEGORY = "999999"
PAGE_SIZE = 500
DETAIL_BATCH = 80
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json, text/plain, */*",
    "TWN-Source": "Hoogvliet web",
}
DETAIL_URL_RE = re.compile(r'"GetProductDetailsFromISH"\s*:\s*"([^"]+)"')


async def request(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    params: dict[str, Any] | None = None,
    retries: int = 5,
) -> httpx.Response:
    for attempt in range(1, retries + 1):
        try:
            response = await client.request(method, url, params=params, headers=HEADERS, timeout=90.0)
        except (httpx.TimeoutException, httpx.NetworkError):
            if attempt == retries:
                raise
            await backoff_sleep(attempt, base=1.5)
            continue
        if should_retry(response.status_code) and attempt < retries:
            await backoff_sleep(attempt, base=1.5)
            continue
        response.raise_for_status()
        return response
    raise RuntimeError(f"Hoogvliet request failed: {url}")


async def navigation_page(client: httpx.AsyncClient, page: int, page_size: int) -> dict:
    response = await request(
        client,
        "GET",
        NAVIGATION_URL,
        params={
            "tn_cid": ROOT_CATEGORY,
            "tn_p": page,
            "tn_ps": page_size,
            "tn_lang": "nl",
        },
    )
    return response.json()


async def detail_endpoint(client: httpx.AsyncClient) -> str:
    response = await request(client, "GET", HOME_URL)
    match = DETAIL_URL_RE.search(response.text)
    if not match:
        raise RuntimeError("Hoogvliet Intershop detail endpoint not found on homepage")
    return html.unescape(match.group(1))


async def fetch_details(
    client: httpx.AsyncClient, endpoint: str, skus: list[str]
) -> dict[str, dict]:
    details: dict[str, dict] = {}
    for start in range(0, len(skus), DETAIL_BATCH):
        chunk = skus[start : start + DETAIL_BATCH]
        response = await request(
            client, "POST", endpoint, params={"products": ",".join(chunk)}
        )
        for row in response.json() or []:
            sku = str(row.get("sku") or "")
            if sku:
                details[sku] = row
        print(f"  detail {min(start + DETAIL_BATCH, len(skus))}/{len(skus)}")
    return details


def envelope(item: dict, detail: dict | None) -> dict:
    sku = str(item.get("itemno"))
    return {
        "store": STORE,
        "scraped_at": now_iso(),
        "external_id": sku,
        "raw": {"item": item, "detail": detail},
    }


async def run(*, limit: int | None, no_detail: bool, page_size: int) -> None:
    out_path = default_output_path(STORE)
    async with httpx.AsyncClient(http2=True, follow_redirects=True) as client:
        first = await navigation_page(client, 1, page_size)
        properties = first.get("properties") or {}
        total = int(properties.get("nrofitems") or len(first.get("items") or []))
        pages = int(properties.get("nrofpages") or 1)
        if limit:
            pages = min(pages, max(1, (limit + page_size - 1) // page_size))
        print(f"Hoogvliet catalog: {total} products across {pages} requested pages")

        items_by_sku: dict[str, dict] = {}
        for page in range(1, pages + 1):
            data = first if page == 1 else await navigation_page(client, page, page_size)
            for item in data.get("items") or []:
                sku = str(item.get("itemno") or "")
                if sku:
                    items_by_sku.setdefault(sku, item)
                    if limit and len(items_by_sku) >= limit:
                        break
            print(f"  page {page}/{pages}: total unique {len(items_by_sku)}")
            if limit and len(items_by_sku) >= limit:
                break

        skus = list(items_by_sku)
        details: dict[str, dict] = {}
        if not no_detail and skus:
            endpoint = await detail_endpoint(client)
            details = await fetch_details(client, endpoint, skus)

        with JsonlWriter(out_path) as writer:
            for sku in skus:
                writer.write(envelope(items_by_sku[sku], details.get(sku)))
    print(f"Wrote {len(skus)} products to {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Scrape Hoogvliet into bronze JSONL.")
    parser.add_argument("--limit", type=int, default=None, help="Cap products (smoke test)")
    parser.add_argument("--no-detail", action="store_true", help="Skip Intershop batch hydration")
    parser.add_argument("--page-size", type=int, default=PAGE_SIZE, help="Tweakwise page size")
    args = parser.parse_args()
    asyncio.run(run(limit=args.limit, no_detail=args.no_detail, page_size=args.page_size))


if __name__ == "__main__":
    main()
