"""Выделенный worker: извлечение аудио из видео и текст/OCR из PDF без внешнего egress."""
from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import shutil
import subprocess
import tarfile
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask

MAX_SOURCE_BYTES = int(os.getenv("MEDIA_WORKER_MAX_MB", "2048")) * 1024 * 1024
JOB_TIMEOUT = int(os.getenv("MEDIA_WORKER_TIMEOUT_SECONDS", "3600"))
TOKEN = os.getenv("MEDIA_WORKER_TOKEN", "")
WORK_DIR = Path(os.getenv("MEDIA_WORKER_DIR", "/tmp/media-worker"))
WORK_DIR.mkdir(parents=True, exist_ok=True)
app = FastAPI(title="Fugu Deck Media Worker", docs_url=None, redoc_url=None)
slots = asyncio.Semaphore(int(os.getenv("MEDIA_WORKER_CONCURRENCY", "2")))


@app.get("/healthz")
async def health():
    return {"ok": bool(TOKEN)}


async def run(*args: str) -> None:
    proc = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), JOB_TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise RuntimeError("обработка превысила ограничение по времени")
    if proc.returncode:
        raise RuntimeError(stderr.decode(errors="replace")[-500:])


@app.post("/extract")
async def extract(request: Request):
    if not TOKEN or not secrets.compare_digest(request.headers.get("authorization", ""), f"Bearer {TOKEN}"):
        return JSONResponse({"error": "нужен токен media-worker"}, status_code=401)
    try:
        chunk_seconds = int(request.headers.get("x-deck-media-chunk-seconds", "600"))
    except ValueError:
        chunk_seconds = 0
    if not 60 <= chunk_seconds <= 1800:
        return JSONResponse({"error": "длина фрагмента должна быть 60..1800 секунд"}, status_code=400)
    if request.headers.get("content-type", "").split(";", 1)[0] != "application/octet-stream":
        return JSONResponse({"error": "нужен application/octet-stream"}, status_code=400)
    length = request.headers.get("content-length", "")
    if not length.isdigit() or not 0 < int(length) <= MAX_SOURCE_BYTES:
        return JSONResponse({"error": f"нужен непустой файл до {MAX_SOURCE_BYTES // 1024 // 1024} МБ"}, status_code=413)
    if slots.locked():
        return JSONResponse({"error": "media-worker занят, повторите позже"}, status_code=503)
    await slots.acquire()
    work = Path(tempfile.mkdtemp(dir=WORK_DIR))
    source = work / "source.media"
    try:
        size = 0
        with source.open("wb") as out:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_SOURCE_BYTES or size > int(length):
                    return JSONResponse({"error": "размер файла не совпадает с Content-Length"}, status_code=400)
                out.write(chunk)
        if size != int(length):
            return JSONResponse({"error": "загрузка оборвалась"}, status_code=400)
        probe = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error", "-protocol_whitelist", "file", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(source),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(probe.communicate(), 60)
        try:
            duration = float(stdout.decode().strip())
        except ValueError:
            duration = 0
        if probe.returncode or not 0 < duration <= 24 * 3600:
            return JSONResponse({"error": "не удалось прочитать видео или оно длиннее 24 часов"}, status_code=400)
        pattern = str(work / "chunk_%05d.ogg")
        await run("ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-i", str(source),
                  "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k",
                  "-f", "segment", "-segment_time", str(chunk_seconds), pattern)
        chunks = sorted(work.glob("chunk_*.ogg"))
        if not chunks:
            return JSONResponse({"error": "в файле нет звуковой дорожки"}, status_code=400)
        source.unlink()
        archive = work / "audio.tar"
        with tarfile.open(archive, "w") as tar:
            for path in chunks:
                tar.add(path, arcname=path.name, recursive=False)
                path.unlink()
        response = FileResponse(archive, media_type="application/x-tar", filename="audio.tar",
                                headers={"X-Deck-Media-Duration": str(duration)},
                                background=BackgroundTask(shutil.rmtree, work, ignore_errors=True))
        work = Path()
        return response
    except Exception as e:
        return JSONResponse({"error": f"FFmpeg: {str(e)[:500]}"}, status_code=422)
    finally:
        slots.release()
        if work != Path():
            shutil.rmtree(work, ignore_errors=True)


PDF_MAX_BYTES = int(os.getenv("PDF_WORKER_MAX_MB", "200")) * 1024 * 1024
PDF_MAX_PAGES = int(os.getenv("PDF_WORKER_MAX_PAGES", "400"))
PDF_OUTPUT_MAX = 16 * 1024 * 1024
PDF_JOB_TTL = 3600
PDF_JOBS: dict[str, dict] = {}
PDF_LOCK = threading.Lock()


class PdfCancelled(ValueError):
    pass


class PDFControl:
    def __init__(self):
        self.cancelled = threading.Event()
        self.lock = threading.Lock()
        self.process: subprocess.Popen | None = None

    def check(self) -> None:
        if self.cancelled.is_set():
            raise PdfCancelled("OCR остановлен пользователем")

    def cancel(self) -> None:
        self.cancelled.set()
        with self.lock:
            if self.process and self.process.poll() is None:
                self.process.kill()


def ocr_image(png: bytes, control: PDFControl | None = None) -> str:
    control = control or PDFControl()
    control.check()
    proc = subprocess.Popen(["tesseract", "stdin", "stdout", "-l", "rus+eng", "--psm", "3"],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    with control.lock:
        control.process = proc
    try:
        stdout, stderr = proc.communicate(input=png, timeout=120)
        control.check()
        if proc.returncode:
            raise RuntimeError("OCR: " + stderr.decode(errors="replace")[-300:])
        return stdout.decode("utf-8", errors="replace").strip()
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.communicate()
        raise RuntimeError("OCR страницы превысил ограничение по времени")
    finally:
        with control.lock:
            control.process = None


def pdf_document(path: Path, start: int = 1, end: int = 0, control: PDFControl | None = None,
                 progress: Callable[[int, int], None] | None = None) -> dict:
    import pymupdf

    control = control or PDFControl()
    doc = pymupdf.open(path)
    try:
        if doc.needs_pass:
            raise ValueError("PDF защищён паролем")
        total = len(doc)
        if total < 1 or total > PDF_MAX_PAGES:
            raise ValueError(f"PDF должен содержать 1..{PDF_MAX_PAGES} страниц")
        end = end or total
        if not 1 <= start <= end <= total:
            raise ValueError(f"Диапазон страниц должен быть в пределах 1..{total}")
        selected = list(range(start - 1, end))
        if progress:
            progress(0, len(selected))
        pages = []
        for done, index in enumerate(selected):
            control.check()
            page = doc[index]
            text = page.get_text("text").strip()
            method = "text"
            if not text:
                pix = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
                text = ocr_image(pix.tobytes("png"), control)
                method = "ocr"
            tables = []
            if method == "text" and hasattr(page, "find_tables"):
                try:
                    tables = [table.extract() for table in page.find_tables().tables]
                except Exception:
                    tables = []
            pages.append({"page": index + 1, "method": method, "text": text,
                          "tables": tables, "images": len(page.get_images(full=True))})
            if progress:
                progress(done + 1, len(selected))
        markdown = "\n\n".join(f"## Страница {p['page']}\n\n{p['text']}" for p in pages) + "\n"
        result = {"source_pages": total, "selected_pages": len(selected), "page_start": start, "page_end": end,
                  "pages": pages, "text": "\n\n".join(p["text"] for p in pages),
                  "markdown": markdown, "ocr_pages": sum(p["method"] == "ocr" for p in pages)}
        if len(json.dumps(result, ensure_ascii=False).encode()) > PDF_OUTPUT_MAX:
            raise ValueError("Результат PDF превышает 16 МБ — обработайте документ по частям")
        return result
    finally:
        doc.close()


def pdf_job_id(value: str) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9_-]{8,64}", value))


def pdf_job_view(job: dict) -> dict:
    return {key: job[key] for key in ("job_id", "status", "progress", "pages_done", "pages_total", "error", "updated_at")}


def pdf_job_get(jid: str, owner: str) -> dict | None:
    with PDF_LOCK:
        job = PDF_JOBS.get(jid)
        if not job or not secrets.compare_digest(job["owner"], owner):
            return None
        return job


def pdf_job_put(jid: str, owner: str, start: int, end: int, control: PDFControl) -> dict:
    with PDF_LOCK:
        cutoff = time.time() - PDF_JOB_TTL
        for old in [key for key, value in PDF_JOBS.items()
                    if value["status"] not in {"queued", "running"} and value["updated_at"] < cutoff]:
            PDF_JOBS.pop(old, None)
        job = {"job_id": jid, "owner": owner, "start": start, "end": end, "control": control,
               "status": "running", "progress": 0.0, "pages_done": 0, "pages_total": 0,
               "error": "", "result": None, "updated_at": time.time()}
        PDF_JOBS[jid] = job
        return job


def pdf_job_update(job: dict, **fields) -> None:
    with PDF_LOCK:
        job.update(fields, updated_at=time.time())


async def pdf_status_response(job: dict, result: bool = False):
    if result and job["status"] == "done":
        return JSONResponse(job["result"], headers={"X-Deck-Job-Id": job["job_id"]})
    if result:
        return JSONResponse(pdf_job_view(job), status_code=202 if job["status"] in {"queued", "running"} else 409,
                            headers={"X-Deck-Job-Id": job["job_id"]})
    return JSONResponse(pdf_job_view(job), headers={"X-Deck-Job-Id": job["job_id"]})


@app.get("/pdf/{jid}")
async def pdf_status(jid: str, request: Request):
    if not TOKEN or not secrets.compare_digest(request.headers.get("authorization", ""), f"Bearer {TOKEN}"):
        return JSONResponse({"error": "нужен токен media-worker"}, status_code=401)
    job = pdf_job_get(jid, request.headers.get("x-deck-namespace", "")) if pdf_job_id(jid) else None
    return await pdf_status_response(job) if job else JSONResponse({"error": "PDF-задача не найдена"}, status_code=404)


@app.get("/pdf/{jid}/result")
async def pdf_result(jid: str, request: Request):
    if not TOKEN or not secrets.compare_digest(request.headers.get("authorization", ""), f"Bearer {TOKEN}"):
        return JSONResponse({"error": "нужен токен media-worker"}, status_code=401)
    job = pdf_job_get(jid, request.headers.get("x-deck-namespace", "")) if pdf_job_id(jid) else None
    return await pdf_status_response(job, result=True) if job else JSONResponse({"error": "PDF-задача не найдена"}, status_code=404)


@app.post("/pdf/{jid}/cancel")
async def pdf_cancel(jid: str, request: Request):
    if not TOKEN or not secrets.compare_digest(request.headers.get("authorization", ""), f"Bearer {TOKEN}"):
        return JSONResponse({"error": "нужен токен media-worker"}, status_code=401)
    job = pdf_job_get(jid, request.headers.get("x-deck-namespace", "")) if pdf_job_id(jid) else None
    if not job:
        return JSONResponse({"error": "PDF-задача не найдена"}, status_code=404)
    if job["status"] in {"queued", "running"}:
        pdf_job_update(job, status="cancelled", error="Остановлено пользователем")
        job["control"].cancel()
    return await pdf_status_response(job)


@app.post("/pdf")
async def pdf(request: Request):
    if not TOKEN or not secrets.compare_digest(request.headers.get("authorization", ""), f"Bearer {TOKEN}"):
        return JSONResponse({"error": "нужен токен media-worker"}, status_code=401)
    length = request.headers.get("content-length", "")
    if request.headers.get("content-type", "").split(";", 1)[0] != "application/octet-stream":
        return JSONResponse({"error": "нужен application/octet-stream"}, status_code=400)
    if not length.isdigit() or not 0 < int(length) <= PDF_MAX_BYTES:
        return JSONResponse({"error": f"нужен PDF до {PDF_MAX_BYTES // 1024 // 1024} МБ"}, status_code=413)
    jid = request.headers.get("x-deck-job-id", "") or secrets.token_hex(16)
    if not pdf_job_id(jid):
        return JSONResponse({"error": "недопустимый ID PDF-задачи"}, status_code=400)
    try:
        start, end = int(request.headers.get("x-deck-pdf-start", "1")), int(request.headers.get("x-deck-pdf-end", "0"))
    except ValueError:
        return JSONResponse({"error": "недопустимый диапазон страниц"}, status_code=400)
    if start < 1 or start > PDF_MAX_PAGES or end < 0 or end > PDF_MAX_PAGES or (end and start > end):
        return JSONResponse({"error": "недопустимый диапазон страниц"}, status_code=400)
    owner = request.headers.get("x-deck-namespace", "")
    existing = pdf_job_get(jid, owner)
    if existing:
        if existing["start"] != start or existing["end"] != end:
            return JSONResponse({"error": "ID PDF-задачи уже использован с другим диапазоном"}, status_code=409)
        if existing["status"] == "done":
            return await pdf_status_response(existing, result=True)
        return await pdf_status_response(existing)
    if slots.locked():
        return JSONResponse({"error": "media-worker занят, повторите позже"}, status_code=503)
    await slots.acquire()
    work = Path(tempfile.mkdtemp(dir=WORK_DIR))
    source = work / "source.pdf"
    control = PDFControl()
    job = pdf_job_put(jid, owner, start, end, control)
    try:
        size = 0
        with source.open("wb") as out:
            async for chunk in request.stream():
                size += len(chunk)
                if size > int(length) or size > PDF_MAX_BYTES:
                    return JSONResponse({"error": "размер PDF не совпадает с Content-Length"}, status_code=400)
                out.write(chunk)
        if size != int(length):
            return JSONResponse({"error": "загрузка оборвалась"}, status_code=400)

        def progress(done: int, total: int) -> None:
            if job["status"] == "running":
                pdf_job_update(job, progress=done / max(1, total), pages_done=done, pages_total=total)

        try:
            result = await asyncio.wait_for(asyncio.to_thread(pdf_document, source, start, end, control, progress), JOB_TIMEOUT)
            if job["status"] == "cancelled":
                raise PdfCancelled("OCR остановлен пользователем")
            pdf_job_update(job, status="done", progress=1.0, result=result)
            return JSONResponse(result, headers={"X-Deck-Job-Id": jid})
        except PdfCancelled as e:
            pdf_job_update(job, status="cancelled", error=str(e))
            return JSONResponse({"error": str(e)}, status_code=409, headers={"X-Deck-Job-Id": jid})
        except ValueError as e:
            pdf_job_update(job, status="error", error=str(e)[:500])
            return JSONResponse({"error": str(e)[:500]}, status_code=422, headers={"X-Deck-Job-Id": jid})
    except Exception as e:
        pdf_job_update(job, status="error", error=str(e)[:500])
        return JSONResponse({"error": f"PDF worker: {str(e)[:500]}"}, status_code=422, headers={"X-Deck-Job-Id": jid})
    finally:
        slots.release()
        shutil.rmtree(work, ignore_errors=True)
