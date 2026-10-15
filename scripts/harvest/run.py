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

import boto3
import requests

import hub

API = os.environ["HARVEST_API"].rstrip("/")
PUBLISH = API.replace("/api/harvest", "/api/publish")
TOKEN = os.environ["HARVEST_TOKEN"]
R2_ENDPOINT = os.environ.get("R2_ENDPOINT", "")
R2_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET = os.environ.get("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET = os.environ.get("R2_BUCKET", "")
PART = 28 * 1024 * 1024  # < 32 MB R2 part ceiling


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


def s3():
    return boto3.client(
        "s3",
        endpoint_url=R2_ENDPOINT,
        aws_access_key_id=R2_KEY_ID,
        aws_secret_access_key=R2_SECRET,
        region_name="auto",
    )


def publish_and_upload(job: dict, pdf: bytes, pages: int) -> dict:
    if not (R2_ENDPOINT and R2_BUCKET and R2_KEY_ID):
        raise RuntimeError("R2 not configured in this runner")

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
        raise RuntimeError("catalog already lists this book without a PDF and without our deleteKey")

    client = s3()
    chunks = 0
    for idx, off in enumerate(range(0, len(pdf), PART)):
        part = pdf[off : off + PART]
        client.put_object(Bucket=R2_BUCKET, Key=f"book/{book_id}/{idx}", Body=part)
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
    if not (R2_ENDPOINT and R2_BUCKET and R2_KEY_ID and R2_SECRET):
        print("R2 not configured in this runner — nothing to do", flush=True)
        return 0
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
