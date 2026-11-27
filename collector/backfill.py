"""Durable article backfill using Huey's own SQLite queue and retry engine.

Only integration/state reconciliation is local code. HTTP download and article
extraction reuse collect.read_with_trafilatura (Trafilatura); successful bodies
go through the existing validated JSON outbox/importer, never direct SQL edits.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import contextmanager, closing
from datetime import datetime, timezone
import json
import os
import re
from pathlib import Path
import sqlite3
import time
from urllib.parse import urlsplit
import uuid

from huey import SqliteHuey

from collect import APP, atomic_json, now, public_body_url, read_with_trafilatura


DEFAULT_POLICY = dict(enabled=True, interval_seconds=120, max_attempts=4,
                      retry_delay_seconds=300, retry_backoff=2,
                      minimum_body_chars=120, host_delay_seconds=2)


@contextmanager
def worker_lock(path):
    """An OS-owned lock releases after a crash, allowing queue reconciliation."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        handle.seek(0)
        if not handle.read(1):
            handle.write(b"0"); handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


class BodyQueue:
    def __init__(self, database, data_dir, config, policy=None, fetcher=None):
        self.database, self.data_dir = Path(database), Path(data_dir)
        self.policy = {**DEFAULT_POLICY, **(policy or {})}
        self.sources = {s["id"]: s for s in config["sources"]}
        self.fetcher = fetcher or read_with_trafilatura
        self.directory = self.data_dir / "body-backfill"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.huey = SqliteHuey("zhichao-bodies", filename=str(self.directory / "queue.sqlite3"),
                              results=False, utc=True, fsync=True)
        self.db = sqlite3.connect(self.directory / "queue.sqlite3", timeout=30)
        self.db.row_factory = sqlite3.Row
        # UI/reconciliation metadata only. Huey owns queueing, priorities,
        # scheduled tasks, retry counts/delays, and serialization.
        self.db.execute("CREATE TABLE IF NOT EXISTS article_body_state (article_id TEXT PRIMARY KEY, details TEXT NOT NULL)")
        self.db.commit()
        self.task = self.huey.task(name="zhichao.fetch_article_body", context=True,
                                  retries=self.policy["max_attempts"] - 1,
                                  retry_delay=self.policy["retry_delay_seconds"],
                                  retry_backoff=self.policy["retry_backoff"])(self.fetch)
        self.host_attempts = {}

    def close(self):
        self.db.close()
        self.huey.storage.close()

    def content_db(self):
        connection = sqlite3.connect(f"file:{self.database.as_posix()}?mode=ro", uri=True, timeout=30)
        connection.row_factory = sqlite3.Row
        return connection

    def state(self, article_id):
        row = self.db.execute("SELECT details FROM article_body_state WHERE article_id=?", (article_id,)).fetchone()
        return json.loads(row[0]) if row else {}

    def save(self, article_id, **values):
        state = {**self.state(article_id), **values, "article_id": article_id, "updated_at": now()}
        self.db.execute("INSERT INTO article_body_state VALUES (?,?) ON CONFLICT(article_id) DO UPDATE SET details=excluded.details",
                        (article_id, json.dumps(state, ensure_ascii=False)))
        self.db.commit()
        atomic_json(self.directory / "articles" / f"{article_id}.json", state)
        return state

    def record(self, article_id):
        with closing(self.content_db()) as db:
            article = db.execute("SELECT * FROM content_articles WHERE id=?", (article_id,)).fetchone()
            if not article:
                return None, []
            links = [dict(r) for r in db.execute("SELECT * FROM content_article_sources WHERE article_id=? ORDER BY source_id", (article_id,))]
        return dict(article), links

    def eligible_source(self, links):
        return next((self.sources[r["source_id"]] for r in links if r["source_id"] in self.sources
                     and self.sources[r["source_id"]].get("enabled", True)
                     and self.sources[r["source_id"]].get("read_body", False)), None)

    def reconcile(self, retry_failed=False, only=None):
        """Rescan the durable content library, including articles off the feeds.

        Re-create orphaned tasks after an interrupted dequeue/execution, while
        retaining native Huey scheduled retries and avoiding duplicate tasks.
        """
        queued_ids = {task.id for task in [*self.huey.pending(), *self.huey.scheduled()]}
        with closing(self.content_db()) as db:
            rows = [dict(r) for r in db.execute("SELECT * FROM content_articles ORDER BY published_at DESC, id")]
        for article in rows:
            aid = article["id"]
            if only and aid not in only:
                continue
            state = self.state(aid)
            if article["content_status"] == "full_text" and len(article.get("content_text") or "") >= self.policy["minimum_body_chars"]:
                if state and state.get("state") != "complete":
                    self.save(aid, state="complete", next_retry_at=None, error=None)
                continue
            if not self.policy["enabled"]:
                continue
            _, links = self.record(aid)
            source = self.eligible_source(links)
            if not source:
                self.save(aid, state="disabled", error="来源未启用正文补抓", next_retry_at=None)
                continue
            # A fetched body is waiting for the existing importer, not another
            # network fetch. Quarantined/missing payloads are visible failures.
            if state.get("state") == "awaiting_import":
                filename = state.get("outbox_file", "")
                if filename and (self.data_dir / "outbox" / filename).is_file():
                    continue
                self.save(aid, state="failed", error="正文已提取但入库未完成，请检查入库日志", next_retry_at=None)
                if not retry_failed:
                    continue
            if state.get("task_id") in queued_ids:
                continue
            if state.get("state") in {"failed", "blocked"} and not retry_failed:
                continue
            signature = self.task.s(aid, priority=100 if not article.get("content_text") else 20)
            # State before enqueue makes a crash here recoverable on next scan.
            self.save(aid, state="queued", task_id=signature.id, source_id=source["id"],
                      attempts=state.get("attempts", 0), next_retry_at=None,
                      error=None, queued_at=now())
            self.huey.enqueue(signature)

    def fetch(self, article_id, task=None):
        article, links = self.record(article_id)
        if not article:
            self.save(article_id, state="failed", error="文章记录不存在", next_retry_at=None)
            return
        if article["content_status"] == "full_text" and len(article.get("content_text") or "") >= self.policy["minimum_body_chars"]:
            self.save(article_id, state="complete", next_retry_at=None, error=None)
            return
        source = self.eligible_source(links)
        if not source:
            self.save(article_id, state="disabled", error="来源已停用正文补抓", next_retry_at=None)
            return
        url = article["canonical_url"]
        hosts = source.get("body_hosts", [urlsplit(source["url"]).hostname])
        if not public_body_url(url, hosts):
            self.save(article_id, state="blocked", error="无法确认文章地址为公开网络地址，未发起请求", next_retry_at=None)
            return
        # The initial off-source URL has passed public DNS checks. Redirects
        # stay on these publisher hosts; the existing downloader validates each.
        allowed_hosts = list(set([*hosts, urlsplit(url).hostname]))
        host = urlsplit(url).hostname
        delay = self.policy["host_delay_seconds"] - (time.monotonic() - self.host_attempts.get(host, 0))
        if delay > 0:
            time.sleep(delay)
        self.host_attempts[host] = time.monotonic()
        state = self.save(article_id, state="running", attempts=self.state(article_id).get("attempts", 0) + 1,
                          last_attempt_at=now(), next_retry_at=None, error=None)
        try:
            result = self.fetcher(url, allowed_hosts, minimum_chars=self.policy["minimum_body_chars"])
            text = ((result.get("data") or {}).get("content") or "").strip()
            if not result.get("success") or len(text) < self.policy["minimum_body_chars"]:
                message = (result.get("error") or {}).get("message", "未提取到足够正文")
                # Access-denied pages must not become article text or spin in
                # an automatic retry loop. A manual admin retry remains possible.
                if any(f"{code} Client Error" in message for code in [401, 403, 404, 410, 419]):
                    self.save(article_id, state="blocked", error=message[:500], next_retry_at=None)
                    return
                raise RuntimeError(message[:500])
            lower = text[:1000].lower()
            if len(text) < 1000 and any(x in lower for x in ["verify you are human", "just a moment...", "checking your browser", "access denied"]):
                self.save(article_id, state="blocked", error="来源返回访问验证页面，未保存为正文", next_retry_at=None)
                return
            link = next(r for r in links if r["source_id"] == source["id"])
            observation = json.loads(link["data_json"])
            stamp = now()
            observation.update({k: article[k] for k in ["canonical_url", "title", "author", "kind", "published_at", "publication_precision", "modified_at"]})
            observation.update(content_status="full_text", content_text=text[:200000], content_provider="trafilatura",
                               content_fetched_at=stamp, crawled_at=stamp, body_error=None)
            batch_id = "body-" + uuid.uuid4().hex
            run = dict(source_id=source["id"], name=source["name"], kind=source["kind"], url=source["url"],
                       status="success", attempted_at=stamp, fetched_at=stamp, last_success_at=stamp,
                       error=None, items_count=1, rejected_count=0)
            atomic_json(self.data_dir / "outbox" / f"{batch_id}.json", dict(schema_version=1, purpose="body_backfill",
                        batch_id=batch_id, collected_at=stamp, source_runs=[run], articles=[observation]))
            atomic_json(self.data_dir / "body-cache" / f"{article_id}.json", {**result, "retrieved_at": stamp})
            self.save(article_id, state="awaiting_import", error=None, next_retry_at=None,
                      outbox_file=f"{batch_id}.json", body_chars=len(text[:200000]), provider="trafilatura")
        except Exception as error:
            remaining = task.retries if task else 0
            retry_at = datetime.fromtimestamp(time.time() + (task.retry_delay if task else 0), timezone.utc).isoformat(timespec="seconds")
            self.save(article_id, state="retrying" if remaining else "failed", error=str(error)[:500],
                      next_retry_at=retry_at if remaining else None)
            raise  # Huey schedules and executes its native bounded retries.

    def drain(self, budget):
        for task in self.huey.read_schedule():
            self.huey.enqueue(task)
        processed = 0
        for _ in range(max(0, budget)):
            task = self.huey.dequeue()
            if task is None:
                break
            self.huey.execute(task)
            processed += 1
            self.snapshot()
        return processed

    def snapshot(self):
        states = [json.loads(row[0]) for row in self.db.execute("SELECT details FROM article_body_state")]
        counts = Counter(row["state"] for row in states)
        summary = {"enabled": self.policy["enabled"], "updated_at": now(), "counts": dict(counts),
                   "queued": self.huey.pending_count(), "scheduled": self.huey.scheduled_count(),
                   "next_retry_at": min((row["next_retry_at"] for row in states if row.get("next_retry_at")), default=None)}
        atomic_json(self.directory / "status.json", summary)
        return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("CONTENT_DATA_DIR", APP / "data")))
    parser.add_argument("--database", type=Path, default=Path(os.environ.get("CONTENT_DB_PATH", APP / "data/content.sqlite3")))
    parser.add_argument("--config", type=Path, default=APP / "config/sources.json")
    parser.add_argument("--policy", type=Path, default=APP / "config/body-backfill.json")
    parser.add_argument("--budget", type=int)
    parser.add_argument("--only", action="append", default=[])
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--enqueue-only", action="store_true")
    parser.add_argument("--status-only", action="store_true")
    args = parser.parse_args()
    if any(not re.fullmatch(r"[a-f0-9]{64}", value) for value in args.only):
        parser.error("--only expects article IDs")
    config = json.loads(args.config.read_text(encoding="utf-8-sig"))
    policy = json.loads(args.policy.read_text(encoding="utf-8-sig"))
    if not 1 <= policy.get("max_attempts", 4) <= 8 or not 120 <= policy.get("minimum_body_chars", 120) <= 2000:
        parser.error("Invalid backfill retry/body policy")
    budget = config.get("max_body_reads", 12) if args.budget is None else args.budget
    if not 0 <= budget <= 20:
        parser.error("Body budget must be 0–20")
    with worker_lock(args.data_dir / "body-backfill/worker.lock"):
        queue = BodyQueue(args.database, args.data_dir, config, policy)
        try:
            if queue.policy["enabled"] or args.status_only:
                queue.reconcile(retry_failed=args.retry_failed, only=set(args.only) or None)
                if not args.status_only and not args.enqueue_only:
                    queue.drain(budget)
            print(json.dumps(queue.snapshot(), ensure_ascii=False))
        finally:
            queue.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
