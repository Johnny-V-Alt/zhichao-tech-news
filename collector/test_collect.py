from collect import PreservingRSSParser, canonical_url, normalize_date


def test_dates_do_not_invent_publication_or_timezone():
    assert normalize_date(None) == (None, "unknown")
    assert normalize_date("2026-11-25") == ("2026-11-25", "date")
    assert normalize_date("2026-11-25T10:30:00") == (None, "unknown")
    assert normalize_date("2026-11-25T10:30:00+08:00") == ("2026-11-25T02:30:00+00:00", "second")
    assert normalize_date("2026-11-25 10:30:00", "minute", "Asia/Shanghai") == ("2026-11-25T02:30:00+00:00", "minute")


def test_atom_updated_is_not_publication_and_old_time_is_retained():
    parser = PreservingRSSParser()
    items = parser.parse('''<feed xmlns="http://www.w3.org/2005/Atom"><title>Test</title>
      <entry><id>old</id><title>Old story</title><link href="https://example.com/old"/>
      <published>2020-01-01T00:00:00Z</published><updated>2026-11-25T00:00:00Z</updated></entry>
      <entry><id>unknown</id><title>Unknown</title><link href="https://example.com/unknown"/>
      <updated>2026-11-25T00:00:00Z</updated></entry></feed>''')
    assert items[0].published_at == "2020-01-01T00:00:00+00:00"
    assert items[1].published_at is None
    assert parser.metadata[items[0].url]["modified_raw"] == "2026-11-25T00:00:00Z"


def test_json_feed_modified_is_separate_and_text_reuses_upstream_cleanup():
    parser = PreservingRSSParser()
    item = parser.parse('''{"version":"https://jsonfeed.org/version/1.1","items":[
      {"id":"1","url":"https://example.com/1","title":"Test", "date_modified":"2026-11-25T00:00:00Z", "content_html":"<p>Useful &amp; clear</p>"}]}''')[0]
    assert item.published_at is None
    assert parser.metadata[item.url]["feed_content"] == "Useful & clear"


def test_url_cleanup_retains_content_parameters_and_rejects_unsafe_links():
    assert canonical_url("https://EXAMPLE.com/a?source=one&ref=two&utm_source=x#track") == "https://example.com/a?source=one&ref=two"
    import pytest
    for url in ["javascript:alert(1)", "http://127.0.0.1/private", "https://user:pass@example.com/a"]:
        with pytest.raises(ValueError):
            canonical_url(url)


def test_one_source_failure_does_not_block_other_sources(monkeypatch, tmp_path):
    import json
    from collect import DataFetcher, collect_source
    def fetch(_self, source_id, **_):
        if source_id == "bad":
            return None, source_id, source_id
        return json.dumps({"status":"success", "updatedTime":1795608000000,
                           "items":[{"id":"1", "title":"Tech news", "url":"https://example.com/1"}]}), source_id, source_id
    monkeypatch.setattr(DataFetcher, "fetch_data", fetch)
    source = {"id":"good", "name":"Test", "kind":"tech_media", "adapter":"newsnow", "upstream_id":"good", "url":"https://example.com/"}
    bad, bad_items = collect_source({**source, "id":"bad", "upstream_id":"bad"}, {"newsnow_api":"http://127.0.0.1/api/s"}, tmp_path)
    good, good_items = collect_source(source, {"newsnow_api":"http://127.0.0.1/api/s"}, tmp_path)
    assert bad["status"] == "failed" and not bad_items
    assert bad["last_success_at"] is None
    assert good["status"] == "success" and len(good_items) == 1


def test_body_reader_failure_keeps_publisher_summary(monkeypatch, tmp_path):
    from collect import ArticleReaderTools, base_article, enrich_bodies
    import collect
    source = {"id":"blog", "kind":"developer_blog", "url":"https://example.com/", "read_body":True}
    article = base_article(source, "1", "Tech story", "https://example.com/1", "2026-11-25T00:00:00+00:00")
    article.update(content_status="source_summary", content_text="Publisher supplied summary")
    monkeypatch.setattr(collect, "public_body_url", lambda *_: True)
    monkeypatch.setattr(ArticleReaderTools, "read_article", lambda *_args, **_kw: {"success":False,"error":{"message":"Rate limited"}})
    monkeypatch.setattr(collect, "read_with_trafilatura", lambda *_: {"success":False,"error":{"message":"Rate limited"}})
    enrich_bodies([article], [source], tmp_path, 1)
    assert article["content_text"] == "Publisher supplied summary"
    assert article["content_status"] == "source_summary"
    assert article["body_error"] == "Rate limited"


def test_known_publishers_support_proxy_only_dns_but_local_hosts_stay_blocked():
    from collect import public_body_url
    assert public_body_url("https://example.com/story", ["example.com"])
    assert not public_body_url("http://127.0.0.1/private", ["127.0.0.1"])
    assert not public_body_url("https://localhost/private", ["localhost"])
