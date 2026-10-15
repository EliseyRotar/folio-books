"""Download one HUB (Mondadori) book to a single PDF.

Faithful port of vvettoretti/hubscuola-downloader's flow:
token-mode auth, publication.zip -> publication.db (SQLite chapter
index), per-chapter zips -> extract PDFs -> merge in order.
"""
import io
import json
import sqlite3
import zipfile

import requests

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
)


def login(email: str, password: str, session: requests.Session) -> str:
    r = session.get(
        "https://bce.mondadorieducation.it//app/mondadorieducation/login/loginJsonp",
        params={"username": email, "password": password},
        timeout=60,
    )
    body = r.json()
    if body.get("result") != "OK":
        raise RuntimeError(body.get("error") or "mondadori login failed")
    d = body["data"]
    r2 = session.post(
        "https://ms-api.hubscuola.it/user/internalLogin",
        json={"username": d["username"], "sessionId": d["sessionId"], "jwt": d["hubEncryptedUser"]},
        timeout=60,
    ).json()
    tok = r2.get("tokenId")
    if not tok:
        raise RuntimeError("internalLogin returned no tokenId")
    return tok


def download(book_id: str, token: str, platform: str = "young") -> bytes:
    from pypdf import PdfWriter

    session = requests.Session()
    session.headers["user-agent"] = UA
    session.headers["token-session"] = token

    pub = session.get(
        f"https://ms-mms.hubscuola.it/downloadPackage/{book_id}/publication.zip?tokenId={token}",
        timeout=300,
    )
    pub.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(pub.content)) as archive:
        archive.extract("publication/publication.db", "/tmp/harvest")
    con = sqlite3.connect("/tmp/harvest/publication/publication.db")
    try:
        row = con.execute(
            "SELECT offline_value FROM offline_tbl WHERE offline_path=?",
            (f"meyoung/publication/{book_id}",),
        ).fetchone()
    finally:
        con.close()
    if not row:
        raise RuntimeError("publication.db has no offline index for this book")

    chapters = json.loads(row[0])["indexContents"]["chapters"]
    writer = PdfWriter()
    for ch in chapters:
        url = (
            f"https://ms-mms.hubscuola.it/public/{book_id}/{ch['chapterId']}.zip"
            f"?tokenId={token}&app=v2"
        )
        blob = session.get(url, timeout=300).content
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            for name in sorted(archive.namelist()):
                if ".pdf" in name.lower():
                    data = archive.read(name)
                    writer.append(io.BytesIO(data))
    out = io.BytesIO()
    writer.write(out)
    pages = len(writer.pages)
    return out.getvalue(), pages


def run(job: dict) -> tuple[bytes, int]:
    secrets = json.loads(job.get("secrets") or "{}")
    token = (secrets.get("token") or "").strip()
    session = requests.Session()
    session.headers["user-agent"] = UA
    if not token:
        email = (secrets.get("email") or "").strip()
        password = secrets.get("password") or ""
        if not email or not password:
            raise RuntimeError("job has neither token nor email/password")
        token = login(email, password, session)
    platform = (secrets.get("platform") or job.get("platform") or "young").lower()
    return download(job["book_id"], token, platform)
