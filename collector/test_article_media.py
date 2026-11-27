import json
from pathlib import Path
from lxml import html
import pytest
import article_media
from collect import atomic_json


def test_document_preserves_image_position_headings_lists_and_code(tmp_path, monkeypatch):
    monkeypatch.setattr(article_media,"cache_image",lambda *a: ("/api/content/images/"+"a"*64,42))
    markup='<html><body><h2>Release</h2><p>Before <b>image</b></p><img src="/photo.png"/><p>After image</p><ul><li>Item</li></ul><pre><code>print(1)</code></pre></body></html>'
    result=article_media.prepare_document(markup,"https://example.com/news",tmp_path,lambda *a:True,{},atomic_json)
    tree=html.fragment_fromstring(result["content_html"],create_parent='div')
    assert [n.tag for n in tree]==['h2','p','img','p','ul','pre']
    assert result['rich_version']==1 and result['image_count']==1 and result['image_error_count']==0
    assert result['image_url'].endswith('a'*64)


def test_image_failure_keeps_text_and_truthful_placeholder(tmp_path,monkeypatch):
    def blocked(*args):raise ValueError("Forbidden")
    monkeypatch.setattr(article_media,"cache_image",blocked)
    result=article_media.prepare_document('<html><body><p>Text retained</p><img src="/x"/></body></html>',"https://example.com",tmp_path,lambda *a:True,{},atomic_json)
    assert 'Text retained' in result['content_html'] and '<img' not in result['content_html']
    assert result['image_error_count']==1 and result['image_url'] is None


def test_nonpublic_images_and_svg_are_not_cached(tmp_path,monkeypatch):
    def forbidden(*args,**kwargs):raise AssertionError("Unsafe URL was fetched")
    monkeypatch.setattr(article_media.requests,'get',forbidden)
    with pytest.raises(ValueError):article_media.cache_image('https://127.0.0.1/image',tmp_path,lambda *a:False,{},atomic_json)
    with pytest.raises(ValueError):article_media.image_type(b'<svg onload="alert(1)"/>')


def test_verified_image_is_cached_once_and_checked_on_redirects(tmp_path,monkeypatch):
    calls=[]
    class Response:
        is_redirect=False
        headers={'Content-Type':'image/png'}
        def __enter__(self):return self
        def __exit__(self,*a):pass
        def raise_for_status(self):pass
        def iter_content(self,size):yield b'\x89PNG\r\n\x1a\n' + b'fixture-image'
    def get(url,**kwargs):calls.append(url);return Response()
    monkeypatch.setattr(article_media.requests,'get',get)
    first,size=article_media.cache_image('https://example.com/i.png',tmp_path,lambda *a:True,{},atomic_json)
    second,_=article_media.cache_image('https://example.com/i.png',tmp_path,lambda *a:True,{},atomic_json)
    assert first==second and size>0 and len(calls)==1
    assert json.loads((tmp_path/(first.rsplit('/',1)[1]+'.json')).read_text())['type']=='image/png'
    class Redirect(Response):
        is_redirect=True
        headers={'Location':'https://127.0.0.1/private'}
    monkeypatch.setattr(article_media.requests,'get',lambda *a,**k:Redirect())
    with pytest.raises(ValueError):article_media.cache_image('https://example.com/new.png',tmp_path,lambda url,*a:'127.0.0.1' not in url,{},atomic_json)
