import threading
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.db import Database
from app.media import MediaWorker


def pdf_file(path: Path, pages: int = 3) -> None:
    import pymupdf

    doc = pymupdf.open()
    for number in range(1, pages + 1):
        doc.new_page().insert_text((72, 72), f"page {number}")
    doc.save(path)
    doc.close()


def test_pdf_range_status_result_and_namespace(tmp_path: Path, monkeypatch):
    from app import media_worker

    media_worker.PDF_JOBS.clear()
    monkeypatch.setattr(media_worker, "TOKEN", "worker-secret")
    monkeypatch.setattr(media_worker, "WORK_DIR", tmp_path)
    source = tmp_path / "range.pdf"
    pdf_file(source)
    client = TestClient(media_worker.app)
    headers = {
        "Authorization": "Bearer worker-secret", "Content-Type": "application/octet-stream",
        "X-Deck-Job-Id": "pdf-job-range", "X-Deck-Namespace": "deck-u-anna",
        "X-Deck-PDF-Start": "2", "X-Deck-PDF-End": "3",
    }
    response = client.post("/pdf", content=source.read_bytes(), headers=headers)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["source_pages"] == 3 and data["selected_pages"] == 2
    assert [page["page"] for page in data["pages"]] == [2, 3]
    status = client.get("/pdf/pdf-job-range", headers=headers)
    assert status.status_code == 200
    assert status.json()["pages_done"] == 2 and status.json()["pages_total"] == 2
    result = client.get("/pdf/pdf-job-range/result", headers=headers)
    assert result.status_code == 200 and result.json()["selected_pages"] == 2
    other = {**headers, "X-Deck-Namespace": "deck-u-mallory"}
    assert client.get("/pdf/pdf-job-range", headers=other).status_code == 404
    assert client.post("/pdf", content=source.read_bytes(), headers={**headers, "X-Deck-Job-Id": "bad id"}).status_code == 400
    assert client.post("/pdf", content=source.read_bytes(), headers={**headers, "X-Deck-Job-Id": "pdf-job-other",
                                                                    "X-Deck-PDF-Start": "3", "X-Deck-PDF-End": "2"}).status_code == 400


def test_pdf_cancel_reaches_running_ocr(tmp_path: Path, monkeypatch):
    from app import media_worker

    media_worker.PDF_JOBS.clear()
    monkeypatch.setattr(media_worker, "TOKEN", "worker-secret")
    monkeypatch.setattr(media_worker, "WORK_DIR", tmp_path)
    started = threading.Event()

    def blocking_ocr(_png, control):
        started.set()
        assert control.cancelled.wait(5)
        control.check()
        return ""

    monkeypatch.setattr(media_worker, "ocr_image", blocking_ocr)
    source = tmp_path / "scan.pdf"
    pdf_file(source, 1)
    doc = __import__("pymupdf").open()
    page = doc.new_page()
    page.draw_rect(__import__("pymupdf").Rect(20, 20, 100, 100), fill=(0, 0, 0))
    doc.save(source)
    doc.close()
    client = TestClient(media_worker.app)
    headers = {"Authorization": "Bearer worker-secret", "Content-Type": "application/octet-stream",
               "X-Deck-Job-Id": "pdf-job-cancel", "X-Deck-Namespace": "deck-u-anna"}
    responses = []

    def process():
        responses.append(client.post("/pdf", content=source.read_bytes(), headers=headers))

    thread = threading.Thread(target=process)
    thread.start()
    assert started.wait(5)
    cancelled = client.post("/pdf/pdf-job-cancel/cancel", headers=headers)
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled"
    thread.join(timeout=5)
    assert not thread.is_alive()
    assert responses[0].status_code == 409
    assert client.get("/pdf/pdf-job-cancel", headers=headers).json()["status"] == "cancelled"


def test_pdf_active_content_is_not_executed_or_returned(tmp_path: Path):
    import pymupdf
    from app.media_worker import pdf_document

    source = tmp_path / "active.pdf"
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), "safe text")
    doc.xref_set_key(doc.pdf_catalog(), "OpenAction", "<</S/JavaScript/JS(app.alert('x'))>>")
    doc.save(source)
    doc.close()
    result = pdf_document(source)
    assert result["text"] == "safe text"
    assert "JavaScript" not in result["markdown"] and "app.alert" not in result["markdown"]


@pytest.mark.asyncio
async def test_remote_pdf_uses_existing_worker_job(tmp_path: Path, monkeypatch):
    calls = []

    async def handler(request):
        calls.append((request.method, request.url.path))
        if request.url.path == "/media/pdf/pdf-job-resume":
            done = sum(1 for method, path in calls if method == "GET" and path == "/media/pdf/pdf-job-resume") > 1
            return httpx.Response(200, json={"job_id": "pdf-job-resume", "status": "done" if done else "running",
                                             "progress": 1 if done else 0.5, "pages_done": 2 if done else 1, "pages_total": 2})
        if request.url.path == "/media/pdf/pdf-job-resume/result":
            return httpx.Response(200, json={"source_pages": 2, "selected_pages": 2, "pages": [], "text": "ok"})
        return httpx.Response(404, json={"error": "unexpected"})

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client(*args, **kwargs):
        return real_client(transport=transport)

    monkeypatch.setattr("app.media.httpx.AsyncClient", client)
    monkeypatch.setattr("app.media.kgc.token", lambda: "space-token")
    source = tmp_path / "source.pdf"
    source.write_bytes(b"pdf")
    db = Database(str(tmp_path / "db.sqlite"))
    await db.connect()
    worker = MediaWorker(db, Settings(data_dir=tmp_path, keyguard_url="http://keyguard"))
    job = {"id": "pdf-job-resume", "conversation_id": "c", "created_by": "u", "options": {"start": 1, "end": 2}}
    result = await worker._remote_pdf(job, source)
    assert result["text"] == "ok"
    assert calls == [("GET", "/media/pdf/pdf-job-resume"), ("GET", "/media/pdf/pdf-job-resume"),
                     ("GET", "/media/pdf/pdf-job-resume/result")]
    await db.close()


@pytest.mark.asyncio
async def test_transcribe_resumes_after_completed_chunk(tmp_path: Path):
    settings = Settings(data_dir=tmp_path)
    db = Database(str(settings.db_path))
    await db.connect()
    await db._exec("INSERT INTO conversations (id,model,created_at,updated_at) VALUES ('c','openai:test',1,1)")
    source = tmp_path / "voice.ogg"
    source.write_bytes(b"audio")
    att = await db.add_attachment("c", "voice.ogg", "audio/ogg", 5, str(source))
    job = await db.create_media_job("c", att["id"], "transcribe", "google", "u")
    work = settings.data_dir / "media" / job["id"]
    work.mkdir(parents=True)
    (work / "chunk_00000.ogg").write_bytes(b"first")
    (work / "chunk_00001.ogg").write_bytes(b"second")
    first = {"start": 0, "end": 10, "text": "первая часть"}
    await db.update_media_job(job["id"], status="running", progress=0.475,
                              checkpoint={"duration": 1200, "next_chunk": 1, "segments": [first]})
    worker = MediaWorker(db, settings)
    calls = []

    async def transcribe(_job, path, _seconds):
        calls.append(path.name)
        return [{"start": 0, "end": 10, "text": "вторая часть"}]

    async def forbidden(*_args):
        raise AssertionError("probe/extract не должны повторяться")

    worker._transcribe = transcribe
    worker._run = forbidden
    await worker.start()
    done = await worker.wait(job["id"])
    assert done["status"] == "done"
    assert calls == ["chunk_00001.ogg"]
    assert "первая часть" in done["result"]["text"] and "вторая часть" in done["result"]["text"]
    assert not work.exists()
    await worker.stop()
    await db.close()


@pytest.mark.asyncio
async def test_media_checkpoint_migration_from_v29(tmp_path: Path):
    db = Database(str(tmp_path / "existing.sqlite"))
    await db.connect()
    await db._exec("ALTER TABLE media_jobs DROP COLUMN checkpoint")
    await db._exec("ALTER TABLE media_jobs DROP COLUMN options")
    await db._exec("DELETE FROM schema_version")
    await db._exec("INSERT INTO schema_version (v) VALUES (29)")
    await db.close()
    await db.connect()
    await db._exec("INSERT INTO conversations (id,model,created_at,updated_at) VALUES ('c','openai:test',1,1)")
    source = tmp_path / "source.pdf"
    source.write_bytes(b"pdf")
    att = await db.add_attachment("c", "source.pdf", "application/pdf", 3, str(source))
    job = await db.create_media_job("c", att["id"], "pdf", "worker", "u", {"start": 4, "end": 8})
    assert job["options"] == {"start": 4, "end": 8} and job["checkpoint"] == {}
    version = await db._one("SELECT v FROM schema_version")
    assert version["v"] == 30
    await db.close()
