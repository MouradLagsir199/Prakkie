"""Ekoplaza Netherlands full catalog scraper.

The Nuxt storefront exposes its ASPOS category tree and product endpoint on
the same origin.  We walk every active leaf below the Boodschappen root,
paginate it, and deduplicate products that occur in multiple categories.  A
product row includes the live price, DefaultScanCode (EAN), brand, fields,
images and discounts.

Usage:
    python -m scrapers.ekoplaza
    python -m scrapers.ekoplaza --limit 50 --max-categories 3
"""

from __future__ import annotations

import argparse
import asyncio
from collections import defaultdict
from typing import Any

import httpx

from .common import JsonlWriter, backoff_sleep, default_output_path, now_iso, should_retry

STORE = "ekoplaza"
BASE = "https://www.ekoplaza.nl"
WEBNODES_URL = f"{BASE}/api/aspos/webnodes"
PRODUCTS_URL = f"{BASE}/api/aspos/webnodes/{{category_id}}/products"
ROOT_ID = 1
PAGE_SIZE = 100
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json",
    "Referer": f"{BASE}/nl/producten",
}


async def request_json(
    client: httpx.AsyncClient,
    url: str,
    *,
    params: dict[str, Any] | None = None,
    retries: int = 5,
) -> Any:
    for attempt in range(1, retries + 1):
        try:
            response = await client.get(url, params=params, headers=HEADERS, timeout=120.0)
        except (httpx.TimeoutException, httpx.NetworkError):
            if attempt == retries:
                raise
            await backoff_sleep(attempt, base=2.0)
            continue
        if should_retry(response.status_code) and attempt < retries:
            await backoff_sleep(attempt, base=2.0)
            continue
        response.raise_for_status()
        return response.json()
    raise RuntimeError(f"Ekoplaza request failed: {url}")


def index_nodes(payload: list[dict]) -> dict[int, dict]:
    nodes: dict[int, dict] = {}

    def visit(node: dict) -> None:
        node_id = node.get("Id")
        if isinstance(node_id, int):
            nodes[node_id] = {**nodes.get(node_id, {}), **node}
        for child in node.get("Children") or []:
            visit(child)

    for node in payload:
        visit(node)
    return nodes


def leaf_categories(nodes: dict[int, dict]) -> list[tuple[dict, list[str]]]:
    children: dict[int, list[int]] = defaultdict(list)
    for node in nodes.values():
        parent = node.get("ParentId")
        if isinstance(parent, int):
            children[parent].append(node["Id"])

    descendants: set[int] = set()
    stack = list(children.get(ROOT_ID, []))
    while stack:
        node_id = stack.pop()
        if node_id in descendants:
            continue
        descendants.add(node_id)
        stack.extend(children.get(node_id, []))

    def path_for(node_id: int) -> list[str]:
        path: list[str] = []
        seen: set[int] = set()
        current = nodes.get(node_id)
        while current and current.get("Id") not in seen:
            seen.add(current["Id"])
            if current.get("Id") != ROOT_ID:
                label = str(current.get("Description") or "").strip()
                if label:
                    path.append(label)
            current = nodes.get(current.get("ParentId"))
        return list(reversed(path))

    result: list[tuple[dict, list[str]]] = []
    for node_id in descendants:
        node = nodes[node_id]
        active = node.get("Status") == "Active" and node.get("Type") == "Webshop"
        active_children = [child for child in children.get(node_id, []) if child in descendants]
        if active and not active_children:
            result.append((node, path_for(node_id)))
    return sorted(result, key=lambda pair: (pair[1], pair[0]["Id"]))


async def category_page(
    client: httpx.AsyncClient, category_id: int, offset: int
) -> dict:
    return await request_json(
        client,
        PRODUCTS_URL.format(category_id=category_id),
        params={
            "limit": PAGE_SIZE,
            "offset": offset,
            "realtimeStock": "true",
            "fetchExtraFields": "true",
        },
    )


def envelope(product: dict, category_path: list[str], extra_fields: dict | None) -> dict:
    product_id = str(product.get("Id"))
    return {
        "store": STORE,
        "scraped_at": now_iso(),
        "external_id": product_id,
        "raw": {
            "product": product,
            "category_path": category_path,
            "extra_fields": extra_fields or {},
        },
    }


async def run(*, limit: int | None, max_categories: int | None) -> None:
    out_path = default_output_path(STORE)
    async with httpx.AsyncClient(http2=True, follow_redirects=True) as client:
        nodes = index_nodes(await request_json(client, WEBNODES_URL))
        categories = leaf_categories(nodes)
        if max_categories:
            categories = categories[:max_categories]
        print(f"Walking {len(categories)} Ekoplaza leaf categories")

        seen: set[str] = set()
        written = 0
        category_failures: list[tuple[int, str]] = []
        with JsonlWriter(out_path) as writer:
            for index, (category, path) in enumerate(categories, start=1):
                offset = 0
                added = 0
                try:
                    while True:
                        data = await category_page(client, category["Id"], offset)
                        products = data.get("Products") or []
                        extras = data.get("ExtraFields") or {}
                        for product in products:
                            product_id = str(product.get("Id") or "")
                            if not product_id or product_id in seen:
                                continue
                            seen.add(product_id)
                            writer.write(envelope(product, path, extras.get(product_id)))
                            written += 1
                            added += 1
                            if limit and written >= limit:
                                break
                        if (limit and written >= limit) or not data.get("HasMore") or not products:
                            break
                        offset += len(products)
                except Exception as error:
                    # A single broken/slow ASPOS leaf must not throw away every
                    # category already collected. Keep the complete remainder
                    # and make the skipped leaf explicit in the run summary.
                    category_failures.append(
                        (category["Id"], str(error).splitlines()[0][:240])
                    )
                print(f"  [{index}/{len(categories)}] {' / '.join(path)}: +{added} (total {written})")
                if limit and written >= limit:
                    break
    print(f"Wrote {written} products to {out_path}")
    if category_failures:
        sample = ", ".join(str(category_id) for category_id, _ in category_failures[:10])
        print(
            f"Warning: {len(category_failures)} categories failed after retries "
            f"(sample ids: {sample})"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Scrape Ekoplaza into bronze JSONL.")
    parser.add_argument("--limit", type=int, default=None, help="Cap products (smoke test)")
    parser.add_argument("--max-categories", type=int, default=None, help="Cap leaf categories")
    args = parser.parse_args()
    asyncio.run(run(limit=args.limit, max_categories=args.max_categories))


if __name__ == "__main__":
    main()
