"""Collect through pinned TrendRadar modules; bridge their output to NewsNow storage.

No AI calls. Network retry, feed parsing and optional page reading remain upstream code.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import ipaddress
import json
import os
import re
import socket
import sys
import uuid
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.parse import urljoin
from zoneinfo import ZoneInfo

import requests
import trafilatura

APP = Path(__file__).resolve().parents[1]
VENDOR = APP / "vendor" / "TrendRadar"
sys.path.insert(0, str(VENDOR))
from trendradar.crawler.fetcher import DataFetcher
from trendradar.crawler.rss.fetcher import RSSFeedConfig, RSSFetcher
from trendradar.crawler.rss.parser import RSSParser
from mcp_server.tools.article_reader import ArticleReaderTools


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_date(value, precision_hint=None, source_timezone=None):
    """Return explicit UTC, a date-only value, or unknown; never infer a missing zone."""
    if value is None or value == "":
        return None, "unknown"
    try:
        if isinstance(value, (int, float)):
            stamp = value / 1000 if value > 100_000_000_000 else value
            date = datetime.fromtimestamp(stamp, timezone.utc)
        elif re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(value).strip()):
            return datetime.strptime(value.strip(), "%Y-%m-%d").date().isoformat(), "date"
        else:
            text = str(value).strip()
            try:
                date = datetime.fromisoformat(text.replace("Z", "+00:00"))
            except ValueError:
                date = parsedate_to_datetime(text)
            if date.tzinfo is None:
                if not source_timezone:
                    return None, "unknown"
                date = date.replace(tzinfo=ZoneInfo(source_timezone))
            date = date.astimezone(timezone.utc)
        if precision_hint == "minute":
            date = date.replace(second=0, microsecond=0)
        return date.isoformat(timespec="seconds"), precision_hint or "second"
    except (ValueError, TypeError, OverflowError, OSError):
        return None, "unknown"


def canonical_url(url):
    parsed = urlsplit(str(url).strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Only HTTP(S) article URLs without credentials are accepted")
    host = parsed.hostname.lower()
    if host == "localhost" or host.endswith((".localhost", ".local")):
        raise ValueError("Local article URL rejected")
    try:
        if not ipaddress.ip_address(host).is_global:
            raise ValueError("Non-public article URL rejected")
    except ValueError as error:
        if "rejected" in str(error):
            raise
    # Conservative: source/ref/channel and meaningful query order are preserved.
    query = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True)
             if not k.lower().startswith("utm_") and k.lower() not in {"fbclid", "gclid"}]
    netloc = f"[{host}]" if ":" in host else host
    if parsed.port and (parsed.scheme, parsed.port) not in {("https", 443), ("http", 80)}:
        netloc += f":{parsed.port}"
    return urlunsplit((parsed.scheme.lower(), netloc, parsed.path or "/", urlencode(query), ""))


def public_body_url(url, allowed_hosts=()):
    try:
        url = canonical_url(url)
        # Explicit publisher hosts work on proxy-only networks where local DNS
        # is unavailable. Arbitrary URLs still require globally routed DNS.
        if urlsplit(url).scheme == "https" and urlsplit(url).hostname in allowed_hosts:
            return True
        addresses = socket.getaddrinfo(urlsplit(url).hostname, None)
        return bool(addresses) and all(ipaddress.ip_address(x[4][0]).is_global for x in addresses)
    except (ValueError, OSError):
        return False


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix + ".partial")
    partial.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(partial, path)


class PreservingRSSParser(RSSParser):
    """Reuse parsing, text cleanup and entry selection; repair publication semantics only."""

    def __init__(self):
        super().__init__(max_summary_length=200_000)
        self.metadata = {}

    def _parse_date(self, entry):
        return normalize_date(entry.get("published"))[0]

    def _parse_entry(self, entry):
        parsed = super()._parse_entry(entry)
        if parsed:
            content = entry.get("content") or []
            content_text = "\n".join(self._clean_text(part.get("value", "")) for part in content)
            self.metadata[parsed.url] = {
                "published_raw": entry.get("published"), "modified_raw": entry.get("updated"),
                "feed_content": content_text, "feed_summary": self._parse_summary(entry),
            }
        return parsed

    def _parse_json_feed_item(self, item):
        parsed = super()._parse_json_feed_item(item)
        if parsed:
            parsed.published_at = normalize_date(item.get("date_published"))[0]
            self.metadata[parsed.url] = {
                "published_raw": item.get("date_published"), "modified_raw": item.get("date_modified"),
                "feed_content": self._clean_text(item.get("content_text") or item.get("content_html") or ""),
                "feed_summary": self._clean_text(item.get("summary") or ""),
            }
        return parsed


def base_article(source, item_id, title, url, stamp):
    if not isinstance(title, str) or not title.strip() or len(title) > 10000:
        raise ValueError("Invalid source title")
    if len(str(item_id or url)) > 8192:
        raise ValueError("Invalid source item id")
    return {
        "source_id": source["id"], "source_item_id": str(item_id or url),
        "canonical_url": canonical_url(url), "original_url": url, "discussion_url": None,
        "title": title.strip(), "author": None, "kind": source["kind"],
        "published_at": None, "publication_precision": "unknown", "published_raw": None,
        "modified_at": None, "crawled_at": stamp, "content_status": "title_only",
        "content_text": None, "content_provider": None, "content_fetched_at": None,
        "body_error": None, "raw": {},
    }


def collect_source(source, config, raw_dir):
    stamp = now()
    run = {
        "source_id": source["id"], "name": source["name"], "kind": source["kind"],
        "url": source["url"], "status": "failed", "attempted_at": stamp,
        "fetched_at": None, "last_success_at": None, "error": None, "items_count": 0, "rejected_count": 0,
    }
    articles = []
    try:
        if source["adapter"] == "newsnow":
            fetcher = DataFetcher(api_url=config["newsnow_api"])
            text, _, _ = fetcher.fetch_data(source["upstream_id"], max_retries=1, min_retry_wait=1, max_retry_wait=2)
            if text is None:
                raise RuntimeError("Upstream DataFetcher failed after retry; see collector log")
            data = json.loads(text)
            atomic_json(raw_dir / f'{source["id"]}.json', data)
            run["status"] = "cached" if data["status"] == "cache" else "success"
            run["fetched_at"] = normalize_date(data.get("fetchedAt") or data.get("updatedTime"))[0]
            run["last_success_at"] = run["fetched_at"]
            run["error"] = data.get("fetchError")
            for raw in data.get("items", [])[:source.get("max_items", 30)]:
                try:
                    article = base_article(source, raw.get("id"), raw["title"], raw["url"], stamp)
                    article["published_at"], article["publication_precision"] = normalize_date(raw.get("pubDate"), source.get("time_precision"), source.get("timezone"))
                    article["published_raw"] = raw.get("pubDate")
                    article["discussion_url"] = (raw.get("extra") or {}).get("discussionUrl")
                    article["raw"] = raw
                    articles.append(article)
                except (KeyError, ValueError, TypeError):
                    run["rejected_count"] += 1
        elif source["adapter"] == "rss":
            feed = RSSFeedConfig(id=source["id"], name=source["name"], url=source["url"], max_items=source.get("max_items", 12))
            fetcher = RSSFetcher([feed], timeout=config.get("timeout_seconds", 15), freshness_enabled=False)
            parser = PreservingRSSParser()
            fetcher.parser = parser
            def capture(response, **_):
                (raw_dir / f'{source["id"]}.feed').write_text(response.text, encoding="utf-8")
                return response
            fetcher.session.hooks["response"] = [capture]
            try:
                items, error = fetcher.fetch_feed(feed)
            finally:
                fetcher.session.close()
            if error:
                raise RuntimeError(error)
            run.update(status="success", fetched_at=now(), last_success_at=now())
            for item in items:
                try:
                    article = base_article(source, item.guid, item.title, item.url, stamp)
                    meta = parser.metadata.get(item.url, {})
                    raw_date = meta.get("published_raw")
                    article["published_at"], article["publication_precision"] = normalize_date(raw_date)
                    article["published_raw"] = raw_date
                    article["modified_at"] = normalize_date(meta.get("modified_raw"))[0]
                    article["author"] = item.author or None
                    body = meta.get("feed_content") or item.summary or ""
                    if body.strip():
                        article.update(content_status="source_summary", content_text=body[:200_000],
                                       content_provider="feed_content" if meta.get("feed_content") else "feed_summary", content_fetched_at=run["fetched_at"])
                    article["raw"] = {"guid":item.guid, "published":raw_date, "updated":meta.get("modified_raw"), "summary":item.summary}
                    articles.append(article)
                except (ValueError, TypeError):
                    run["rejected_count"] += 1
        else:
            raise ValueError("Unknown adapter")
        run["items_count"] = len(articles)
        if run["rejected_count"]:
            run["status"] = "partial"
            run["error"] = f'{run["rejected_count"]} malformed/unsafe entries excluded'
    except Exception as error:
        articles = []
        run.update(status="failed", error=str(error)[:2000], fetched_at=None, last_success_at=None, items_count=0)
    return run, articles


def read_with_trafilatura(url, allowed_hosts, minimum_chars=120):
    """Small HTTP adapter; all main-text extraction is the third-party library."""
    original_url = url
    try:
        for _ in range(4):
            # Keep redirects on the configured public publisher hosts.
            if urlsplit(url).hostname not in allowed_hosts or not public_body_url(url, allowed_hosts):
                raise ValueError("Page redirect is outside configured publisher hosts")
            with requests.get(url, timeout=15, allow_redirects=False, stream=True,
                              headers={**DataFetcher.DEFAULT_HEADERS, "Accept":"text/html,application/xhtml+xml"}) as response:
                if response.is_redirect:
                    url = urljoin(url, response.headers.get("Location", ""))
                    continue
                response.raise_for_status()
                if "html" not in response.headers.get("Content-Type", "").lower():
                    raise ValueError("Page is not HTML")
                chunks, size = [], 0
                for chunk in response.iter_content(65536):
                    size += len(chunk)
                    if size > 3_000_000:
                        raise ValueError("Page exceeds body download limit")
                    chunks.append(chunk)
            text = trafilatura.extract(b"".join(chunks), url=url, output_format="txt", include_comments=False, favor_precision=True)
            if not text or len(text.strip()) < minimum_chars:
                raise ValueError("No sufficient main text found")
            return {"success":True,"data":{"url":url,"content":text,"provider":"trafilatura"}}
        raise ValueError("Too many publisher redirects")
    except Exception as error:
        return {"success":False,"error":{"url":original_url,"message":str(error)[:2000],"provider":"trafilatura"}}


def enrich_bodies(articles, sources, data_dir, budget):
    reader = ArticleReaderTools(project_root=str(VENDOR))
    cache_dir = data_dir / "body-cache"
    cache_dir.mkdir(exist_ok=True)
    source_options = {x["id"]: x for x in sources}
    used_sources = set()
    for article in sorted(articles, key=lambda x: 0 if x["kind"] in {"developer_blog", "tutorial"} else 1):
        if not source_options[article["source_id"]].get("read_body", False):
            continue
        key = hashlib.sha256(article["canonical_url"].encode()).hexdigest()
        cache = cache_dir / f"{key}.json"
        cached = None
        if cache.is_file():
            try:
                record = json.loads(cache.read_text(encoding="utf-8"))
                age = datetime.now(timezone.utc).timestamp() - cache.stat().st_mtime
                if age < (86400 if record.get("success") else 3600):
                    cached = record
            except (OSError, ValueError):
                pass
        allowed_hosts = source_options[article["source_id"]].get("body_hosts", [urlsplit(source_options[article["source_id"]]["url"]).hostname])
        needs_read = cached is None or (not cached.get("success") and not cached.get("fallback_attempted"))
        if needs_read:
            if budget <= 0 or article["source_id"] in used_sources:
                continue
            if not public_body_url(article["canonical_url"], allowed_hosts):
                article["body_error"] = "Body read skipped: non-public or unresolved URL"
                continue
            used_sources.add(article["source_id"])
            budget -= 1
            if cached is None:
                cached = reader.read_article(article["canonical_url"], provider="jina", timeout=20)
            if not cached.get("success"):
                upstream_error = cached.get("error")
                cached = read_with_trafilatura(article["canonical_url"], allowed_hosts)
                cached["upstream_reader_error"] = upstream_error
                cached["fallback_attempted"] = True
            cached["retrieved_at"] = now()
            atomic_json(cache, cached)
        if cached.get("success"):
            text = (cached.get("data") or {}).get("content", "")
            if "Markdown Content:" in text:
                text = text.split("Markdown Content:", 1)[1].strip()
            if len(text.strip()) >= 200:
                article.update(content_status="full_text", content_text=text[:200_000], content_provider=cached["data"].get("provider", "jina"),
                               content_fetched_at=cached["retrieved_at"], body_error=None)
            else:
                article["body_error"] = "Reader returned insufficient page text"
        else:
            article["body_error"] = str((cached.get("error") or {}).get("message", "Body reader failed"))[:2000]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=APP/"config"/"sources.json")
    parser.add_argument("--data-dir", type=Path, default=APP/"data")
    parser.add_argument("--body-budget", type=int)
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8-sig"))
    os.environ["NO_PROXY"] = ",".join(filter(None, [os.environ.get("NO_PROXY", ""), "127.0.0.1,localhost,::1"]))
    sources = [x for x in config["sources"] if x.get("enabled", True)]
    if len({x["id"] for x in sources}) != len(sources):
        raise ValueError("Source IDs must be unique")
    batch_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex
    raw_dir = args.data_dir/"raw"/batch_id
    raw_dir.mkdir(parents=True, exist_ok=True)
    runs, articles = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(collect_source, source, config, raw_dir) for source in sources]
        for future in futures:
            run, records = future.result()
            runs.append(run)
            articles.extend(records)
    enrich_bodies(articles, sources, args.data_dir, config.get("max_body_reads", 4) if args.body_budget is None else args.body_budget)
    batch = {"schema_version":1, "batch_id":batch_id, "collected_at":now(), "source_runs":runs, "articles":articles}
    destination = args.data_dir/"outbox"/f"{batch_id}.json"
    atomic_json(destination, batch)
    summary = {"batch_id":batch_id, "outbox":str(destination), "articles":len(articles),
               "sources_ok":sum(x["status"] in {"success","cached","partial"} for x in runs),
               "sources_failed":sum(x["status"]=="failed" for x in runs),
               "with_dates":sum(bool(x["published_at"]) for x in articles),
               "with_content":sum(bool(x["content_text"]) for x in articles),
               "page_texts":sum(x["content_status"]=="full_text" for x in articles)}
    atomic_json(args.data_dir/"last-collection.json", summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary["sources_ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
