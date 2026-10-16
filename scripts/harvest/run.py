"""Folio background harvester runner (GitHub Actions).

Claims jobs from /api/harvest, downloads each book, uploads the PDF
straight into the catalog's R2 part layout (one storage copy), seals the
catalog row and reports back. Free-tier safe: no artifacts, no extra
copies, respects the 9 GB queue cap checked at enqueue time.
"""
import json
import os
import sys
import time

import requests

import hub

API = os.environ["HARVEST_API"].rstrip("/")
PUBLISH = API.replace("/api/harvest", "/api/publish")
TOKEN = os.environ["HARVEST_TOKEN"]
PART = 28 * 1024 * 1024  # < 30 MB part ceiling enforced by the endpoint


def api(method: str, action: str, body: dict | None = None, raw: bool = False):
    url = f"{API}?action={action}"
    r = requests.request(
        method,
        url,
        headers={"x-harvest-token": TOKEN, "content-type": "application/json"},
        json=body,
        timeout=60,
    )
    r.raise_for_status()
    return r if raw else r.json()


def publish_and_upload(job: dict, pdf: bytes, pages: int) -> dict:
    filename = (job.get("title") or job["book_id"]).replace("/", "-")[:150] + ".pdf"
    created = requests.post(
        f"{PUBLISH}?step=create",
        json={
            "title": job.get("title") or job["book_id"],
            "platform": "hubscuola",
            "filename": filename,
            "pages": pages,
        },
        timeout=60,
    ).json()
    if not created.get("ok"):
        raise RuntimeError("catalog create failed: " + str(created))
    book_id = created["id"]
    delete_key = created.get("deleteKey", "")

    if created.get("existing") and created.get("hasPdf"):
        return {"catalogId": book_id, "size": 0, "key": "", "already": True}
    if created.get("existing") and not delete_key:
        # metadata-only row published by a device shelf sync — take it over
        adopted = api("POST", "adopt", {"title": job.get("title", "")})
        if not adopted.get("ok"):
            raise RuntimeError("catalog already lists this book and cannot be adopted: " + adopted.get("error", ""))
        book_id = adopted["id"]
        delete_key = adopted["deleteKey"]

    chunks = 0
    for idx, off in enumerate(range(0, len(pdf), PART)):
        part = pdf[off : off + PART]
        r = requests.post(
            f"{API}?action=up&job={job['id']}&id={book_id}&idx={idx}&key={delete_key}",
            headers={"x-harvest-token": TOKEN},
            data=part,
            timeout=300,
        )
        r.raise_for_status()
        if not r.json().get("ok"):
            raise RuntimeError("part upload failed: " + r.text[:200])
        chunks += 1

    sealed = requests.post(
        f"{PUBLISH}?step=upfin",
        json={
            "id": book_id,
            "deleteKey": delete_key,
            "size": len(pdf),
            "chunks": chunks,
            "pages": pages,
            "filename": filename,
        },
        timeout=60,
    ).json()
    if not sealed.get("ok"):
        raise RuntimeError("catalog seal failed: " + str(sealed))
    return {"catalogId": book_id, "size": len(pdf), "key": f"book/{book_id}", "already": False}


def process(job: dict) -> None:
    print(f"→ {job['id']} {job.get('title') or job['book_id']} ({job['platform']})", flush=True)
    try:
        pdf, pages = hub.run(job)
        result = publish_and_upload(job, pdf, pages)
        api(
            "POST",
            "complete",
            {"id": job["id"], "ok": True, **result},
        )
        print(f"  done: {result['catalogId']} ({result['size']} bytes)", flush=True)
    except Exception as e:  # noqa: BLE001 — one bad book must not kill the batch
        print(f"  error: {e}", flush=True)
        api("POST", "complete", {"id": job["id"], "ok": False, "error": str(e)[:480]})


def main() -> int:
    deadline = time.time() + 14 * 60  # stay inside the runner's 15-min budget
    while time.time() < deadline:
        jobs = api("POST", "claim", {"limit": 2}).get("jobs") or []
        if not jobs:
            print("queue empty", flush=True)
            return 0
        for job in jobs:
            process(job)
            if time.time() > deadline:
                print("time budget up", flush=True)
                return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
