"""Bounded image caching around the existing requests/lxml extraction stack.

No image transformation. Only verified public HTTPS raster images are cached;
the public image API reads these files and never fetches an arbitrary URL.
"""
import hashlib
import json
from pathlib import Path
import time
from urllib.parse import urljoin, urlsplit

from lxml import html as lhtml
import requests

TRUSTED_IMAGE_HOSTS = ("img.ithome.com", "www.solidot.org", "github.blog",
                       "blog.cloudflare.com", "hacks.mozilla.org", "files.realpython.com")
RICH_VERSION = 1


def image_type(data):
    if data.startswith(b"\xff\xd8\xff"): return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"): return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"): return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP": return "image/webp"
    if data[4:8] == b"ftyp" and data[8:12] in (b"avif", b"avis"): return "image/avif"
    raise ValueError("Unsupported image bytes")


def cache_image(url, directory, public_url, headers, atomic_json):
    directory = Path(directory)
    key = hashlib.sha256(url.encode()).hexdigest()
    index = directory / "urls" / f"{key}.json"
    if index.is_file():
        cached = json.loads(index.read_text(encoding="utf-8"))
        if (directory / f"{cached['id']}.bin").is_file():
            return f"/api/content/images/{cached['id']}", 0
    for _ in range(4):
        if urlsplit(url).scheme != "https" or not public_url(url, TRUSTED_IMAGE_HOSTS):
            raise ValueError("Image is not a verified public HTTPS address")
        with requests.get(url, headers=headers, stream=True, timeout=(5, 8), allow_redirects=False) as response:
            if response.is_redirect:
                url = urljoin(url, response.headers.get("Location", "")); continue
            response.raise_for_status()
            if not response.headers.get("Content-Type", "").lower().startswith("image/"):
                raise ValueError("Response is not an image")
            chunks, size = [], 0
            for chunk in response.iter_content(65536):
                size += len(chunk)
                if size > 4_000_000: raise ValueError("Image exceeds 4 MB limit")
                chunks.append(chunk)
            data = b"".join(chunks)
        mime = image_type(data)
        asset = hashlib.sha256(data).hexdigest()
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"{asset}.bin"
        temporary = target.with_suffix(".partial")
        temporary.write_bytes(data); temporary.replace(target)
        atomic_json(directory / f"{asset}.json", {"type": mime, "bytes": len(data)})
        atomic_json(index, {"id": asset})
        return f"/api/content/images/{asset}", len(data)
    raise ValueError("Too many image redirects")


def prepare_document(markup, url, data_dir, public_url, headers, atomic_json):
    """Preserve Trafilatura's HTML order; localize images within bounded work."""
    root = lhtml.fromstring(markup)
    started, downloaded, count, errors = time.monotonic(), 0, 0, 0
    for number, image in enumerate(root.xpath("//img")):
        try:
            if number >= 24 or downloaded >= 12_000_000 or time.monotonic() - started > 30:
                raise ValueError("Image work limit reached")
            original = urljoin(url, image.get("src") or image.get("data-src") or "")
            local, size = cache_image(original, Path(data_dir) / "article-images", public_url, headers, atomic_json)
            image.set("src", local)
            for attr in list(image.attrib):
                if attr not in {"src", "alt", "title", "width", "height"}: del image.attrib[attr]
            downloaded += size; count += 1
        except Exception:
            # Keep a visible, truthful place in the article, never a tracking or
            # unverified remote URL. The original article link remains above.
            image.tag = "span"; image.attrib.clear()
            image.text = "［配图暂未取得，可通过原文查看；管理员可重试图文补全］"
            errors += 1
    body = root.find("body") if root.tag == "html" else root
    if body is None: body = root
    content = "".join(lhtml.tostring(child, encoding="unicode") for child in body) if body.tag in {"body", "html"} else lhtml.tostring(body, encoding="unicode")
    if len(content) > 600_000: raise ValueError("Article HTML exceeds storage limit")
    return {"content_html": content, "rich_version": RICH_VERSION,
            "image_count": count, "image_error_count": errors,
            "image_url": next(iter(body.xpath('.//img/@src')), None)}
