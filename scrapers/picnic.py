"""Picnic Netherlands account-bound catalog scraper.

Picnic has no public web assortment.  Its read-only app API requires a Picnic
account, so credentials are never embedded in source code.  Supply an existing
``PICNIC_AUTH_KEY`` (preferred for scheduled jobs), or ``PICNIC_EMAIL`` and
``PICNIC_PASSWORD``.  If login requires 2FA, obtain an auth key interactively
first; the catalog run itself never triggers an SMS or changes account state.

The scraper walks Picnic's category-tree and category page references, extracts
every embedded ``sellingUnit`` and writes the standard bronze envelope.  Picnic
usually does not expose retail EANs; absent EANs remain absent deliberately.

Usage:
    PICNIC_AUTH_KEY=... python -m scrapers.picnic
    PICNIC_EMAIL=... PICNIC_PASSWORD=... python -m scrapers.picnic --limit 50
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import hashlib
import os
import re
from collections import deque
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx

from .common import JsonlWriter, backoff_sleep, default_output_path, now_iso, should_retry

STORE = "picnic"
API_VERSION = "15"
BASE = f"https://storefront-prod.nl.picnicinternational.com/api/{API_VERSION}"
DEVICE_ID = os.environ.get("PICNIC_DEVICE_ID", "3C417201548B2E3B")
AGENT = os.environ.get("PICNIC_AGENT", "30100;1.236.1-15553;")
USER_AGENT = "okhttp/4.9.0"
PAGE_REFERENCE_RE = re.compile(
    r"(?P<page>(?:L1|L2)-category-page-root)(?:\?|[^?]*\?)(?P<query>[^\s#]+)", re.I
)


class PicnicClient:
    def __init__(self) -> None:
        self.auth_key = os.environ.get("PICNIC_AUTH_KEY")
        self.client = httpx.AsyncClient(http2=True, follow_redirects=True)

    def headers(self, *, app_headers: bool = True) -> dict[str, str]:
        headers = {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json; charset=UTF-8",
            "Accept-Language": "nl",
        }
        if self.auth_key:
            headers["x-picnic-auth"] = self.auth_key
        if app_headers:
            headers["x-picnic-agent"] = AGENT
            headers["x-picnic-did"] = DEVICE_ID
        return headers

    async def close(self) -> None:
        await self.client.aclose()

    async def _post_auth(self, path: str, payload: dict[str, Any]) -> httpx.Response:
        response = await self.client.post(
            f"{BASE}{path}",
            headers=self.headers(),
            json=payload,
            timeout=60.0,
        )
        response.raise_for_status()
        return response

    async def login(self, *, interactive: bool = False) -> None:
        if self.auth_key:
            return
        email = os.environ.get("PICNIC_EMAIL")
        password = os.environ.get("PICNIC_PASSWORD")
        if interactive and not email:
            email = input("Picnic e-mailadres: ").strip()
        if interactive and not password:
            password = getpass.getpass("Picnic wachtwoord: ")
        if not email or not password:
            raise RuntimeError(
                "PICNIC_AUTH_KEY ontbreekt; zet die env var, gebruik "
                "PICNIC_EMAIL + PICNIC_PASSWORD, of start met --interactive-auth"
            )
        secret = hashlib.md5(password.encode("utf-8")).hexdigest()  # Picnic app protocol
        response = await self.client.post(
            f"{BASE}/user/login",
            headers=self.headers(app_headers=False),
            json={"key": email, "secret": secret, "client_id": 30100},
            timeout=60.0,
        )
        response.raise_for_status()
        body = response.json()
        self.auth_key = response.headers.get("x-picnic-auth")
        if not self.auth_key:
            raise RuntimeError("Picnic login leverde geen x-picnic-auth key op")
        if body.get("second_factor_authentication_required"):
            code = os.environ.get("PICNIC_2FA_CODE")
            if interactive and not code:
                # Sending an SMS is an external side effect and therefore only
                # happens after the operator explicitly selected interactive auth.
                await self._post_auth("/user/2fa/generate", {"channel": "SMS"})
                code = getpass.getpass("Picnic SMS-code: ").strip()
            if not code:
                raise RuntimeError(
                    "Picnic-account vereist 2FA; gebruik --interactive-auth "
                    "of zet een reeds aangevraagde PICNIC_2FA_CODE"
                )
            verified = await self._post_auth("/user/2fa/verify", {"otp": code})
            verified_key = verified.headers.get("x-picnic-auth")
            if not verified_key:
                raise RuntimeError("Picnic 2FA leverde geen nieuwe x-picnic-auth key op")
            self.auth_key = verified_key

    async def get_json(self, path: str, *, retries: int = 5) -> Any:
        for attempt in range(1, retries + 1):
            try:
                response = await self.client.get(
                    f"{BASE}{path}", headers=self.headers(), timeout=90.0
                )
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
        raise RuntimeError(f"Picnic request failed: {path}")


def walk(value: Any):
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def selling_units(payload: Any) -> list[dict]:
    units: list[dict] = []
    for value in walk(payload):
        if not isinstance(value, dict):
            continue
        for key in ("sellingUnit", "selling_unit"):
            unit = value.get(key)
            if isinstance(unit, dict) and unit.get("id"):
                units.append(unit)
    return units


def page_references(payload: Any) -> list[tuple[str, str, str | None]]:
    """Return (page id, category id, label) references found in Fusion PML."""
    refs: set[tuple[str, str, str | None]] = set()
    for value in walk(payload):
        if isinstance(value, dict):
            page = value.get("id") or value.get("reference")
            params = value.get("parameters") or value.get("request_params") or {}
            category_id = params.get("category_id") if isinstance(params, dict) else None
            if page in {"L1-category-page-root", "L2-category-page-root"} and category_id:
                label = value.get("title") or value.get("label") or value.get("name")
                refs.add((str(page), str(category_id), str(label) if label else None))
        if isinstance(value, str) and "category-page-root" in value:
            match = PAGE_REFERENCE_RE.search(value)
            if not match:
                continue
            query = parse_qs(urlparse("https://picnic.invalid/?" + match.group("query")).query)
            category_id = (query.get("category_id") or [None])[0]
            if category_id:
                refs.add((match.group("page"), category_id, None))
    return sorted(refs)


def page_title(payload: Any) -> str | None:
    for value in walk(payload):
        if isinstance(value, dict):
            header = value.get("header")
            if isinstance(header, dict) and header.get("title"):
                return str(header["title"])
    return None


def envelope(unit: dict, source_page: str, category_path: list[str]) -> dict:
    return {
        "store": STORE,
        "scraped_at": now_iso(),
        "external_id": str(unit.get("id")),
        "raw": {
            "selling_unit": unit,
            "source_page": source_page,
            "category_path": category_path,
        },
    }


def save_auth_key(auth_key: str, output: str) -> None:
    path = Path(output).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(auth_key, encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass


async def run(
    *,
    limit: int | None,
    max_pages: int | None,
    interactive_auth: bool,
    auth_only: bool,
    auth_key_output: str | None,
) -> None:
    out_path = default_output_path(STORE)
    api = PicnicClient()
    try:
        await api.login(interactive=interactive_auth)
        if not api.auth_key:
            raise RuntimeError("Picnic authenticatie leverde geen auth-key op")
        if auth_key_output:
            save_auth_key(api.auth_key, auth_key_output)
            print(f"Picnic auth-key veilig opgeslagen in {Path(auth_key_output).resolve()}")
        if auth_only:
            if not auth_key_output:
                raise RuntimeError("--auth-only vereist --auth-key-output; auth-keys worden nooit geprint")
            return
        root = await api.get_json("/pages/category-tree-root")
        queue: deque[tuple[str, str, list[str]]] = deque()
        for page, category_id, label in page_references(root):
            queue.append((page, category_id, [label] if label else []))

        seen_pages: set[tuple[str, str]] = set()
        seen_products: set[str] = set()
        written = 0
        visited = 0
        with JsonlWriter(out_path) as writer:
            while queue:
                page, category_id, inherited_path = queue.popleft()
                page_key = (page, category_id)
                if page_key in seen_pages:
                    continue
                seen_pages.add(page_key)
                payload = await api.get_json(f"/pages/{page}?category_id={category_id}")
                visited += 1
                title = page_title(payload)
                path = [*inherited_path]
                if title and (not path or path[-1] != title):
                    path.append(title)

                for unit in selling_units(payload):
                    product_id = str(unit.get("id") or "")
                    if not product_id or product_id in seen_products:
                        continue
                    seen_products.add(product_id)
                    writer.write(envelope(unit, f"{page}:{category_id}", path))
                    written += 1
                    if limit and written >= limit:
                        break

                for child_page, child_id, label in page_references(payload):
                    child_path = [*path]
                    if label and (not child_path or child_path[-1] != label):
                        child_path.append(label)
                    queue.append((child_page, child_id, child_path))

                print(f"  page {visited}: {page}:{category_id} (total products {written})")
                if (limit and written >= limit) or (max_pages and visited >= max_pages):
                    break
        print(f"Wrote {written} Picnic products from {visited} pages to {out_path}")
    finally:
        await api.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Scrape Picnic into bronze JSONL.")
    parser.add_argument("--limit", type=int, default=None, help="Cap products (smoke test)")
    parser.add_argument("--max-pages", type=int, default=None, help="Cap category pages")
    parser.add_argument(
        "--interactive-auth",
        action="store_true",
        help="Prompt for missing credentials and handle Picnic SMS 2FA",
    )
    parser.add_argument(
        "--auth-only",
        action="store_true",
        help="Authenticate without scraping (requires --auth-key-output)",
    )
    parser.add_argument(
        "--auth-key-output",
        default=None,
        help="Write the resulting auth-key to a protected file; never prints the key",
    )
    args = parser.parse_args()
    asyncio.run(
        run(
            limit=args.limit,
            max_pages=args.max_pages,
            interactive_auth=args.interactive_auth,
            auth_only=args.auth_only,
            auth_key_output=args.auth_key_output,
        )
    )


if __name__ == "__main__":
    main()
