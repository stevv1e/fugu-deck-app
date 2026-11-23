"""Отдельный FFmpeg-воркер: принимает видео потоком и возвращает tar с аудиофрагментами."""
from __future__ import annotations

import asyncio
import os
import secrets
import shutil
import tarfile
import tempfile
from pathlib import Path

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
