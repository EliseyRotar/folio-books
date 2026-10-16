"""Download one bSmart book to a single PDF.

Server-side port of public/app/lib/engines/bsmart.js (itself a faithful
port of tools/bSmart-downloader):

  1. session cookie -> GET /api/v5/user -> auth_token;
  2. every later call uses the auth_token header (never the cookie);
  3. fresh book info from /api/v6/books/by_book_id/{id} — its
     current_edition.revision is the one the resources URL wants;
  4. resources are paged, assets flattened, filtered on use == "page_pdf";
  5. assets fetch with NO auth headers; pages carrying a msgpack header
     are AES-CBC(256..start) encrypted, key hidden in the my.bsmart.it
     bundle (same extraction as the CLI / browser engine);
  6. each single-page PDF is appended into one output PDF.
"""
import base64
import io
import json
import re
import time

import msgpack
import requests
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
)


def base_of(secrets):
    custom = re.sub(r"^https?://", "", (secrets.get("base") or "").strip().lower()).strip("/")
    if secrets.get("site") == "custom" and custom:
        return custom
    if secrets.get("site") == "digibook24":
        return "web.digibook24.com"
    return "www.bsmart.it"


def auth(cookie: str, base: str) -> str:
    r = requests.get(
        f"https://{base}/api/v5/user",
        headers={"user-agent": UA, "cookie": "_bsw_session_v1_production=" + cookie},
        timeout=60,
    )
    if r.status_code != 200:
        raise RuntimeError(f"bSmart cookie rejected (HTTP {r.status_code}) — grab a fresh _bsw_session_v1_production")
    tok = r.json().get("auth_token") if "json" in r.headers.get("content-type", "") else None
    if not tok:
        raise RuntimeError("bSmart cookie rejected — no auth_token in the reply")
    return tok


def book_info(book_id: str, token: str, base: str):
    r = requests.get(
        f"https://{base}/api/v6/books/by_book_id/{book_id}",
        headers={"user-agent": UA, "auth_token": token},
        timeout=60,
    )
    if r.status_code != 200:
        raise RuntimeError(f"bSmart book info HTTP {r.status_code}")
    info = r.json()
    ed = info.get("current_edition") or {}
    # revision 0 is a real value — never use `or` here
    rev = ed.get("revision", ed.get("id"))
    if rev is None:
        raise RuntimeError("bSmart returned no edition revision for this book")
    return info, rev


def page_assets(book_id: str, rev, token: str, base: str):
    assets = []
    page = 1
    while True:
        r = requests.get(
            f"https://{base}/api/v5/books/{book_id}/{rev}/resources",
            params={"per_page": 500, "page": page},
            headers={"user-agent": UA, "auth_token": token},
            timeout=60,
        )
        if r.status_code != 200:
            break
        part = r.json()
        if not isinstance(part, list):
            break
        for g in part:
            for a in (g or {}).get("assets") or []:
                if a.get("use") == "page_pdf" and a.get("url"):
                    assets.append(a)
        if len(part) < 500:
            break
        page += 1
    return assets


_KEY_PAT = re.compile(
    r"var\s+([A-Za-z_$][\w$]*)=String\.fromCharCode\(([^)]*)\),"
    r"([A-Za-z_$][\w$]*)=[\"']constructor[\"'];\3\[\3\]\[\3\]\((.*?)\)\(\)",
    re.S,
)


def bundle_key() -> bytes:
    page = requests.get("https://my.bsmart.it/", headers={"user-agent": UA}, timeout=60).text
    scripts = [
        m.group(1)
        for m in re.finditer(r'<script[^>]+src="([^"]+\.js[^"]*)"[^>]*>', page)
        if m.group(1).startswith("/")
    ]
    if not scripts:
        raise RuntimeError("bSmart bundle not found on my.bsmart.it")
    for src in scripts:
        text = requests.get("https://my.bsmart.it" + src, headers={"user-agent": UA}, timeout=60).text
        m = _KEY_PAT.search(text)
        if not m:
            continue
        char_var, char_codes, _, expression = m.groups()
        source = [chr(int(x.strip())) for x in char_codes.split(",")]
        idx_re = re.compile(re.escape(char_var) + r"\[(\d+)\]")
        snippet = "".join(source[int(x.group(1))] for x in idx_re.finditer(expression))
        key_m = re.search(
            r"['\"]((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)['\"]", snippet
        )
        if key_m:
            return base64.b64decode(key_m.group(1))
    raise RuntimeError("could not extract the bSmart encryption key from the current bundle")


def decrypt(file: bytes, key: bytes) -> bytes:
    unpacker = msgpack.Unpacker(None, raw=False, strict_map_key=False)
    unpacker.feed(file[:256])
    header = next(unpacker)
    start = int(header.get("start") or 0)
    if not (256 < start <= len(file)):
        raise RuntimeError("bad bSmart page header")
    first = file[256:start]
    iv, ct = first[:16], first[16:]
    dec = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    pt = dec.update(ct) + dec.finalize()
    pad = pt[-1]
    if 0 < pad <= 16 and pt[-pad:] == bytes([pad]) * pad:
        pt = pt[:-pad]
    return pt + file[start:]


def download(book_id: str, token: str, base: str):
    from pypdf import PdfWriter

    info, rev = book_info(book_id, token, base)
    assets = page_assets(book_id, rev, token, base)
    if not assets:
        raise RuntimeError("no page PDFs in this bSmart book — it may still be activating")

    # anything except an explicit false means encrypted (same as the CLI)
    key = bundle_key() if any(a.get("encrypted") is not False for a in assets) else None

    session = requests.Session()
    session.headers["user-agent"] = UA
    writer = PdfWriter()
    for i, a in enumerate(assets):
        url = a["url"]
        if not url.startswith("http"):
            url = "https://" + base + url
        data = None
        last = ""
        for t in range(3):
            if t:
                time.sleep(t * 10)
            try:
                r = session.get(url, timeout=120)
                if r.status_code >= 500:
                    last = f"upstream HTTP {r.status_code}"
                    continue
                if r.status_code != 200:
                    raise RuntimeError(f"page {i + 1}/{len(assets)} returned HTTP {r.status_code}")
                data = r.content
                break
            except requests.RequestException as e:
                last = str(e)
        if data is None:
            raise RuntimeError(f"could not fetch page {i + 1}/{len(assets)}: {last}")
        if a.get("encrypted") is not False:
            if key is None:
                raise RuntimeError("page is encrypted but no key was extracted")
            data = decrypt(data, key)
        writer.append(io.BytesIO(data))
        # gentle pacing — hammering the CDN trips throttling on big books
        time.sleep(0.08)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue(), len(writer.pages), str(info.get("cover") or "")


def run(job: dict) -> tuple[bytes, int, str]:
    secrets = json.loads(job.get("secrets") or "{}")
    cookie = (secrets.get("cookie") or "").strip()
    if not cookie:
        raise RuntimeError("bSmart job has no session cookie")
    base = base_of(secrets)
    token = auth(cookie, base)
    pdf, pages, cover = download(job["book_id"], token, base)
    return pdf, pages, cover
