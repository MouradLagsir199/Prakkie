"""DekaMarkt catalog scraper.

DekaMarkt and Dirk are both Detailresult storefronts.  They expose the same
GraphQL schema, but DekaMarkt has its own gateway, fileserver and default store
assortment.  Reuse the proven Dirk crawler rather than maintaining two copies
of the GraphQL queries.

Usage:
    python -m scrapers.dekamarkt
    python -m scrapers.dekamarkt --limit 30 --max-groups 3
"""

from __future__ import annotations

import argparse
import asyncio

from . import dirk as detailresult

STORE = "dekamarkt"
STORE_ID = 283
GRAPHQL_URL = "https://web-deka-gateway.dekamarkt.nl/graphql"
FILESERVER_BASE = "https://web-fileserver.dekamarkt.nl/"
API_KEY = "6d3a42a3-6d93-4f98-838d-bcc0ab2307fd"


def configure() -> None:
    """Point the shared Detailresult implementation at DekaMarkt."""
    detailresult.STORE = STORE
    detailresult.STORE_ID = STORE_ID
    detailresult.GRAPHQL_URL = GRAPHQL_URL
    detailresult.FILESERVER_BASE = FILESERVER_BASE
    detailresult.HEADERS = {**detailresult.HEADERS, "api_key": API_KEY}


async def run(*, limit: int | None, max_groups: int | None) -> None:
    configure()
    await detailresult.run(limit=limit, max_groups=max_groups)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scrape the DekaMarkt catalog into a bronze JSONL artifact."
    )
    parser.add_argument("--limit", type=int, default=None, help="Cap products (smoke test)")
    parser.add_argument("--max-groups", type=int, default=None, help="Cap webgroups (smoke test)")
    args = parser.parse_args()
    asyncio.run(run(limit=args.limit, max_groups=args.max_groups))


if __name__ == "__main__":
    main()
