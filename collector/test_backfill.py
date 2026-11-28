import hashlib
import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

import backfill
from backfill import BodyQueue


@pytest.fixture
def library(tmp_path, monkeypatch):
    database = tmp_path / "content.sqlite3"
    db = sqlite3.connect(database)
    db.executescript('''
      CREATE TABLE content_articles(id TEXT PRIMARY KEY,canonical_url TEXT,title TEXT,author TEXT,kind TEXT,
        published_at TEXT,publication_precision TEXT,first_seen_at TEXT,last_seen_at TEXT,modified_at TEXT,
        content_status TEXT,content_text TEXT,content_provider TEXT,content_fetched_at TEXT,content_sha256 TEXT,body_error TEXT);
      CREATE TABLE content_article_documents(article_id TEXT PRIMARY KEY,article_fingerprint TEXT,rich_version INTEGER,image_error_count INTEGER);
      CREATE TABLE content_article_sources(article_id TEXT,source_id TEXT,source_item_id TEXT,original_url TEXT,
        discussion_url TEXT,first_seen_at TEXT,last_seen_at TEXT,data_json TEXT);
    ''')
    source = dict(id="publisher", name="Publisher", kind="tech_media", url="https://example.com/feed.xml", read_body=True)
    url = "https://example.com/off-the-hotlist"
    aid = hashlib.sha256(url.encode()).hexdigest()
    article = dict(source_id=source["id"], source_item_id="old-item", canonical_url=url,original_url=url,
                   discussion_url=None,title="An older computing article",author=None,kind="tech_media",
                   published_at="2020-01-01T00:00:00+00:00",publication_precision="second",published_raw=None,
                   modified_at=None,crawled_at="2026-11-25T00:00:00+00:00",content_status="title_only",
                   content_text=None,content_provider=None,content_fetched_at=None,body_error=None,raw={})
    db.execute("INSERT INTO content_articles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
               (aid,url,article["title"],None,"tech_media",article["published_at"],"second",article["crawled_at"],article["crawled_at"],None,"title_only",None,None,None,"initial",None))
    db.execute("INSERT INTO content_article_sources VALUES (?,?,?,?,?,?,?,?)",
               (aid,"publisher","old-item",url,None,article["crawled_at"],article["crawled_at"],json.dumps(article)))
    db.commit();db.close()
    monkeypatch.setattr(backfill, "public_body_url", lambda *_: True)
    return database,tmp_path,{"sources":[source]},aid


def make_queue(library, fetcher=None, **policy):
    db,data,config,aid=library
    return BodyQueue(db,data,config,{"host_delay_seconds":0,**policy},fetcher)


def test_off_feed_articles_are_durable_and_scans_do_not_duplicate(library):
    q=make_queue(library)
    q.reconcile();q.reconcile()
    assert q.huey.pending_count()==1
    first=q.state(library[3])["task_id"]
    q.close()
    q=make_queue(library)
    q.reconcile()
    assert q.huey.pending_count()==1
    assert q.huey.pending()[0].id==first
    q.close()


def test_dequeued_task_is_recovered_after_worker_crash(library):
    q=make_queue(library);q.reconcile()
    assert q.huey.dequeue() is not None
    q.close()
    q=make_queue(library);q.reconcile()
    assert q.huey.pending_count()==1
    q.close()


def test_native_huey_delays_and_bounds_retries_without_losing_existing_text(library):
    def fail(*args,**kwargs):return {"success":False,"error":{"message":"Connection timed out"}}
    q=make_queue(library,fail,max_attempts=2)
    q.reconcile();q.drain(1)
    assert q.state(library[3])["state"]=="retrying"
    assert q.huey.scheduled_count()==1
    retry=q.huey.scheduled()[0]
    assert retry.retries==0 and retry.retry_delay==600
    q.reconcile()
    assert q.huey.pending_count()==0 and q.huey.scheduled_count()==1
    for task in q.huey.read_schedule(datetime.now(timezone.utc).replace(tzinfo=None)+timedelta(hours=1)):
        q.huey.execute(task,timestamp=datetime.now(timezone.utc).replace(tzinfo=None)+timedelta(hours=1))
    assert q.state(library[3])["state"]=="failed"
    assert q.huey.scheduled_count()==0
    q.reconcile();assert q.huey.pending_count()==0
    q.reconcile(retry_failed=True);assert q.huey.pending_count()==1
    q.close()


def test_success_uses_existing_import_outbox_and_retains_original_date(library):
    text="Original publisher article body. "*12
    def success(*args,**kwargs):return {"success":True,"data":{"content":text,"content_html":"<html><body><p>"+text+"</p></body></html>","provider":"trafilatura"}}
    q=make_queue(library,success);q.reconcile();q.drain(1)
    files=list((library[1]/"outbox").glob('*.json'));assert len(files)==1
    batch=json.loads(files[0].read_text(encoding="utf-8"));a=batch["articles"][0]
    assert batch["purpose"]=="body_backfill"
    assert a["content_text"]==text.strip() and a["content_status"]=="full_text"
    assert a["published_at"]=="2020-01-01T00:00:00+00:00"
    assert q.state(library[3])["state"]=="awaiting_import"
    q.reconcile();assert q.huey.pending_count()==0
    with sqlite3.connect(library[0]) as db:
        assert db.execute("SELECT content_text FROM content_articles").fetchone()[0] is None
        db.execute("UPDATE content_articles SET content_status='full_text',content_text=?",(text,))
        db.execute("INSERT INTO content_article_documents VALUES (?,?,?,?)",(library[3],"initial",1,0))
    q.reconcile();assert q.state(library[3])["state"]=="complete"
    q.close()


@pytest.mark.parametrize('message',["403 Client Error: Forbidden","401 Client Error: Unauthorized","404 Client Error: Not Found"])
def test_access_denied_stays_visible_without_automatic_retry_loop(library,message):
    def blocked(*args,**kwargs):return {"success":False,"error":{"message":message}}
    q=make_queue(library,blocked);q.reconcile();q.drain(1)
    assert q.state(library[3])["state"]=="blocked"
    assert q.huey.scheduled_count()==0
    q.reconcile();assert q.huey.pending_count()==0
    q.close()


def test_challenge_page_is_not_saved_as_article(library):
    def challenge(*args,**kwargs):return {"success":True,"data":{"content":"Verify you are human. "*10}}
    q=make_queue(library,challenge);q.reconcile();q.drain(1)
    assert q.state(library[3])["state"]=="blocked"
    assert not (library[1]/"outbox").exists()
    q.close()


def test_disabled_source_is_rechecked_before_download(library):
    def forbidden(*args,**kwargs):raise AssertionError("Should not request a disabled source")
    q=make_queue(library,forbidden);q.reconcile()
    q.sources["publisher"]["read_body"]=False
    q.drain(1)
    assert q.state(library[3])["state"]=="disabled"
    q.close()


def test_non_public_url_is_not_fetched(library,monkeypatch):
    monkeypatch.setattr(backfill,"public_body_url",lambda *_:False)
    def forbidden(*args,**kwargs):raise AssertionError("Should not request an unsafe URL")
    q=make_queue(library,forbidden);q.reconcile();q.drain(1)
    assert q.state(library[3])["state"]=="blocked"
    q.close()


def test_disabled_backfill_policy_does_not_enqueue(library):
    q=make_queue(library,enabled=False);q.reconcile()
    assert q.huey.pending_count()==0
    q.close()


def test_existing_plain_text_is_queued_for_rich_upgrade(library):
    with sqlite3.connect(library[0]) as db:
        db.execute("UPDATE content_articles SET content_status='full_text',content_text=?",("Existing body. "*30,))
    q=make_queue(library);q.reconcile()
    assert q.huey.pending_count()==1
    assert q.huey.pending()[0].priority==1577836800
    q.close()


def test_rich_article_is_not_queued_again_unless_failed_images_are_manually_retried(library):
    with sqlite3.connect(library[0]) as db:
        db.execute("UPDATE content_articles SET content_status='full_text',content_text=?",("Existing body. "*30,))
        db.execute("INSERT INTO content_article_documents VALUES (?,?,?,?)",(library[3],"initial",1,1))
    q=make_queue(library);q.reconcile()
    assert q.huey.pending_count()==0
    q.reconcile(retry_failed=True)
    assert q.huey.pending_count()==1 and q.state(library[3])["retry_images"]
    assert q.huey.pending()[0].priority==2**52
    q.close()


def test_plain_text_only_result_retries_rich_upgrade_without_losing_existing_body(library):
    original="Existing verified body. "*12
    with sqlite3.connect(library[0]) as db:
        db.execute("UPDATE content_articles SET content_status='full_text',content_text=?",(original,))
    def incomplete(*args,**kwargs):return {"success":True,"data":{"content":"New plain text. "*20}}
    q=make_queue(library,incomplete);q.reconcile();q.drain(1)
    assert q.state(library[3])["state"]=="retrying"
    assert not (library[1]/"outbox").exists()
    assert q.record(library[3])[0]["content_text"]==original
    q.close()


def test_latest_summary_precedes_old_full_text_and_legacy_pending_tasks_migrate(library):
    old_id=library[3]
    new_url="https://example.com/new-story"
    new_id=hashlib.sha256(new_url.encode()).hexdigest()
    with sqlite3.connect(library[0]) as db:
        db.row_factory=sqlite3.Row
        old=dict(db.execute("SELECT * FROM content_articles").fetchone())
        db.execute("UPDATE content_articles SET content_status='full_text',content_text=?",("Old body. "*30,))
        fresh={**old,"id":new_id,"canonical_url":new_url,"published_at":"2026-11-27T00:00:00+00:00","content_status":"source_summary","content_text":"Source summary"}
        db.execute("INSERT INTO content_articles VALUES ("+','.join('?' for _ in fresh)+")",tuple(fresh.values()))
        observation=json.loads(db.execute("SELECT data_json FROM content_article_sources").fetchone()[0])
        observation.update(canonical_url=new_url,original_url=new_url,source_item_id='new')
        db.execute("INSERT INTO content_article_sources VALUES (?,?,?,?,?,?,?,?)",(new_id,'publisher','new',new_url,None,old['first_seen_at'],old['last_seen_at'],json.dumps(observation)))
    q=make_queue(library)
    old_task=q.task.s(old_id,priority=200)
    new_task=q.task.s(new_id,priority=20)
    new_task.retries=1
    for task in [old_task,new_task]:
        q.save(task.args[0],state='queued',task_id=task.id,attempts=0)
        q.huey.enqueue(task)
    q.reconcile()
    pending=q.huey.pending()
    assert [t.args[0] for t in pending]==[new_id,old_id]
    assert pending[0].id==new_task.id and pending[0].retries==1
    assert q.huey.pending_count()==2
    q.close()
    q=make_queue(library);q.reconcile()
    assert [t.args[0] for t in q.huey.pending()]==[new_id,old_id]
    q.close()


def test_unknown_and_invalid_future_dates_do_not_get_fabricated_freshness():
    assert BodyQueue.priority({'published_at':None})==0
    assert BodyQueue.priority({'published_at':'bad date'})==0
    assert BodyQueue.priority({'published_at':'2099-01-01T00:00:00+00:00'})==0
