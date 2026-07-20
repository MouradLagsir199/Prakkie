"""Vomar Netherlands full catalog scraper.

The public Vomar storefront reads its assortment from ``gateway.vomar.nl``:
departments describe the complete taxonomy and ``/products`` paginates every
main group.  Product rows already contain the live price, primary EAN, pack,
brand and image path, so no per-product hydration is necessary.

Usage:
    python -m scrapers.vomar
    python -m scrapers.vomar --limit 50 --max-groups 2
"""

from __future__ import annotations

import argparse
import asyncio
import re
from typing import Any

import httpx

from .common import JsonlWriter, backoff_sleep, default_output_path, now_iso, should_retry

STORE = "vomar"
GATEWAY = "https://gateway.vomar.nl"
FILES_BASE = "https://d3vricquk1sjgf.cloudfront.net"
PAGE_SIZE = 1000
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
HEADERS = {"User-Agent": USER_AGENT, "Accept": "application/json"}


async def request_json(
    client: httpx.AsyncClient,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    retries: int = 5,
) -> Any:
    for attempt in range(1, retries + 1):
        try:
            response = await client.get(
                f"{GATEWAY}{path}", params=params, headers=HEADERS, timeout=60.0
            )
        except (httpx.TimeoutException, httpx.NetworkError):
            if attempt == retries:
                raise
            await backoff_sleep(attempt, base=1.5)
            continue
        if should_retry(response.status_code) and attempt < retries:
            await backoff_sleep(attempt, base=1.5)
            continue
        response.raise_for_status()
        return response.json()
    raise RuntimeError(f"Vomar request failed: {path}")


def slugify(value: str) -> str:
    # Vomar omits ampersands in route slugs ("Baby & Kind" ->
    # /producten/baby-kind, "Zuivel, Boter & Eieren" ->
    # /zuivel-boter-eieren). Spelling it out as "en" yields HTTP 500 pages.
    value = value.lower().replace("&", " ")
    return re.sub(r"[^a-z0-9]+", "-", value).strip("-")


def taxonomy_rows(departments: list[dict]) -> list[dict]:
    rows: list[dict] = []
    for department in departments:
        for main in department.get("mainGroups") or []:
            rows.append(
                {
                    "departmentNumber": department.get("departmentNumber"),
                    "departmentDescription": department.get("departmentDescription"),
                    "mainGroupNumber": main.get("mainGroupNumber"),
                    "mainGroupDescription": main.get("mainGroupDescription"),
                    "subGroups": main.get("subGroups") or [],
                }
            )
    return rows


def envelope(product: dict, taxonomy: dict) -> dict:
    subgroup_number = product.get("subGroupWebShopNumber")
    subgroup = next(
        (
            row.get("subGroupDescription")
            for row in taxonomy.get("subGroups") or []
            if row.get("subGroupNumber") == subgroup_number
        ),
        None,
    )
    category_path = [
        value
        for value in [
            taxonomy.get("departmentDescription"),
            taxonomy.get("mainGroupDescription"),
            subgroup,
        ]
        if value
    ]
    article = product.get("articleNumber")
    product_url = None
    if article:
        parts = [slugify(str(value)) for value in category_path[:2]]
        parts.append(slugify(str(product.get("description") or article)))
        product_url = f"https://www.vomar.nl/producten/{'/'.join(parts)}/{article}"
    return {
        "store": STORE,
        "scraped_at": now_iso(),
        "external_id": str(article or product.get("id")),
        "raw": {
            "product": product,
            "category_path": category_path,
            "product_url": product_url,
            "files_base": FILES_BASE,
        },
    }


async def fetch_group(client: httpx.AsyncClient, taxonomy: dict) -> list[dict]:
    base = {
        "departmentNumber": taxonomy["departmentNumber"],
        "mainGroupNumber": taxonomy["mainGroupNumber"],
        "pageSize": PAGE_SIZE,
    }
    first = await request_json(client, "/products", params={**base, "page": 1})
    products = list(first.get("products") or [])
    pages = int(first.get("totalPages") or 1)
    for page in range(2, pages + 1):
        data = await request_json(client, "/products", params={**base, "page": page})
        products.extend(data.get("products") or [])
    return products


async def run(*, limit: int | None, max_groups: int | None) -> None:
    out_path = default_output_path(STORE)
    async with httpx.AsyncClient(http2=True) as client:
        data = await request_json(client, "/departments")
        groups = taxonomy_rows(data.get("departments") or [])
        if max_groups:
            groups = groups[:max_groups]
        print(f"Walking {len(groups)} Vomar main groups")

        seen: set[str] = set()
        written = 0
        with JsonlWriter(out_path) as writer:
            for index, group in enumerate(groups, start=1):
                products = await fetch_group(client, group)
                added = 0
                for product in products:
                    key = str(product.get("articleNumber") or product.get("id") or "")
                    if not key or key in seen:
                        continue
                    seen.add(key)
                    writer.write(envelope(product, group))
                    written += 1
                    added += 1
                    if limit and written >= limit:
                        break
                print(
                    f"  [{index}/{len(groups)}] {group.get('mainGroupDescription')}: "
                    f"+{added} (total {written})"
                )
                if limit and written >= limit:
                    break
    print(f"Wrote {written} products to {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Scrape Vomar into a bronze JSONL artifact.")
    parser.add_argument("--limit", type=int, default=None, help="Cap products (smoke test)")
    parser.add_argument("--max-groups", type=int, default=None, help="Cap taxonomy groups")
    args = parser.parse_args()
    asyncio.run(run(limit=args.limit, max_groups=args.max_groups))


if __name__ == "__main__":
    main()
