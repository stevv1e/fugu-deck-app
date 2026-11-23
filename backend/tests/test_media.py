import json
from pathlib import Path

import pytest

from app.config import Settings
from app.db import Database
from app.media import (MediaWorker, MediaError, TranscriptFormatError, media_kind, parse_google_segments,
                       post_transient_retry, srt_time, transcript_text)


@pytest.mark.asyncio
async def test_media_transient_retry(monkeypatch):
    class Response:
        headers = {}

        def __init__(self, status_code):
            self.status_code = status_code

    class Client:
        def __init__(self):
            self.calls = 0

        async def post(self, url, **kwargs):
            self.calls += 1
            return Response(503 if self.calls < 3 else 200)

    sleeps = []

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr("app.media.asyncio.sleep", fake_sleep)
    client = Client()
    response = await post_transient_retry(client, "https://example.test")
    assert response.status_code == 200 and client.calls == 3
    assert sleeps == [1, 2]


@pytest.mark.asyncio
async def test_google_transcribe_fallback(tmp_path: Path, monkeypatch):
    class Response:
        headers = {}
        text = ""

        def __init__(self, status_code):
            self.status_code = status_code

        def json(self):
            return {"candidates": [{"content": {"parts": [{"text": '[{"start":0,"end":2,"text":"голос"}]'}]}}]}

    models = []

    async def fake_retry(client, url, **kwargs):
        models.append(kwargs["headers"]["X-Deck-Model"])
        return Response(503 if len(models) == 1 else 200)

    monkeypatch.setattr("app.media.post_transient_retry", fake_retry)
    monkeypatch.setattr("app.media.kgc.enabled", lambda: True)
    monkeypatch.setattr("app.media.kgc.token", lambda: "token")
    settings = Settings(data_dir=tmp_path, keyguard_url="http://keyguard")
    source = tmp_path / "voice.ogg"
    source.write_bytes(b"audio")
    worker = MediaWorker(None, settings)
    job = {"id": "j", "conversation_id": "c", "created_by": "u"}
    got = await worker._google(job, source, 2)
    assert models == ["gemini-3.8-flash", "gemini-3.5-flash-lite"]
    assert got[0]["text"] == "голос"


@pytest.mark.asyncio
async def test_google_transcribe_retries_invalid_json(tmp_path: Path, monkeypatch):
    class Response:
        status_code = 200
        headers = {}
        text = ""

        def __init__(self, text, finish="STOP"):
            self.text_value = text
            self.finish = finish

        def json(self):
            return {"candidates": [{"finishReason": self.finish,
                                    "content": {"parts": [{"text": self.text_value}]}}]}

    calls, bodies = [], []

    async def fake_retry(client, url, **kwargs):
        calls.append(kwargs["headers"]["X-Deck-Model"])
        bodies.append(kwargs["json"])
        return Response('[{"start":' if len(calls) == 1 else '[{"start":0,"end":2,"text":"голос"}]')

    async def fake_sleep(seconds):
        pass

    monkeypatch.setattr("app.media.post_transient_retry", fake_retry)
    monkeypatch.setattr("app.media.asyncio.sleep", fake_sleep)
    monkeypatch.setattr("app.media.kgc.enabled", lambda: True)
    monkeypatch.setattr("app.media.kgc.token", lambda: "token")
    source = tmp_path / "voice.ogg"
    source.write_bytes(b"audio")
    worker = MediaWorker(None, Settings(data_dir=tmp_path, keyguard_url="http://keyguard"))
    job = {"id": "j", "conversation_id": "c", "created_by": "u"}
    got = await worker._google(job, source, 2)
    assert calls == ["gemini-3.8-flash", "gemini-3.8-flash"]
    assert got[0]["text"] == "голос"
    config = bodies[0]["generationConfig"]
    assert config["maxOutputTokens"] == 16384
    assert config["responseSchema"]["type"] == "ARRAY"
    assert config["responseSchema"]["items"]["required"] == ["start", "end", "text"]


@pytest.mark.asyncio
async def test_google_transcribe_reports_truncation(tmp_path: Path, monkeypatch):
    class Response:
        status_code = 200
        headers = {}
        text = ""

        def json(self):
            return {"candidates": [{"finishReason": "MAX_TOKENS",
                                    "content": {"parts": [{"text": '[{"start":'}]}}]}

    async def fake_retry(client, url, **kwargs):
        return Response()

    async def fake_sleep(seconds):
        pass

    monkeypatch.setattr("app.media.post_transient_retry", fake_retry)
    monkeypatch.setattr("app.media.asyncio.sleep", fake_sleep)
    monkeypatch.setattr("app.media.kgc.enabled", lambda: True)
    monkeypatch.setattr("app.media.kgc.token", lambda: "token")
    source = tmp_path / "voice.ogg"
    source.write_bytes(b"audio")
    worker = MediaWorker(None, Settings(data_dir=tmp_path, keyguard_url="http://keyguard"))
    job = {"id": "j", "conversation_id": "c", "created_by": "u"}
    with pytest.raises(TranscriptFormatError, match="MAX_TOKENS"):
        await worker._google(job, source, 600)


@pytest.mark.asyncio
async def test_transcribe_chunk_splits_invalid_response(tmp_path: Path):
    source = tmp_path / "chunk.ogg"
    source.write_bytes(b"audio")
    worker = MediaWorker(None, Settings(data_dir=tmp_path))

    async def fake_run(jid, args):
        Path(args[-1]).write_bytes(b"part")
        return ""

    async def fake_transcribe(job, path, seconds):
        if path == source:
            raise TranscriptFormatError("обрезано")
        return [{"start": 0, "end": 1, "text": path.name}]

    worker._run = fake_run
    worker._transcribe = fake_transcribe
    got = await worker._transcribe_chunk({"id": "j"}, source, 600)
    assert [s["start"] for s in got] == [0, 300]
    assert [s["text"] for s in got] == ["chunk_part0.ogg", "chunk_part1.ogg"]
    assert not (tmp_path / "chunk_part0.ogg").exists()
    assert not (tmp_path / "chunk_part1.ogg").exists()


@pytest.mark.asyncio
async def test_media_report_with_topics(tmp_path: Path, monkeypatch):
    from app.tools.media_tools import media_report

    settings = Settings(data_dir=tmp_path)
    db = Database(str(settings.db_path))
    await db.connect()
    await db._exec("INSERT INTO conversations (id,model,created_at,updated_at) VALUES ('c','openai:test',1,1)")
    source = tmp_path / "meeting.json"
    source.write_text(json.dumps({"segments": [{"start": 65, "end": 70, "text": "Решили выпустить отчёт"}]}))
    att = await db.add_attachment("c", "meeting.json", "application/json", source.stat().st_size, str(source))
    seen = []

    class Provider:
        async def stream(self, key, model, messages, tools, on_text, on_tool, headers=None):
            seen.append((key, model, messages))
            return type("Result", (), {"text": "# Отчёт\n\n[00:01:05] Выпустить отчёт", "usage": None})()

    class Orchestrator:
        def llm_key(self, provider, keys):
            return "key"

        async def _record_usage(self, run, usage):
            pass

    run = type("Run", (), {"model": "kimi:k3", "keys": {}, "llm_key": None, "user": {"id": "u"}})()
    ctx = type("Ctx", (), {"settings": settings, "db": db, "conversation_id": "c", "run": run,
                           "orchestrator": Orchestrator()})()
    monkeypatch.setattr("app.tools.media_tools.get_provider", lambda name, settings: Provider())
    got = await media_report(ctx, {"attachment_id": att["id"], "request": "Решения", "topics": ["релиз"]})
    report = await db.get_attachment(got["attachment"]["id"])
    assert "00:01:05" in Path(report["path"]).read_text()
    assert "Темы: релиз" in seen[0][2][1]["content"]
    assert seen[0][0] == "key" and seen[0][1] == "k3"
    await db.close()


def test_media_formats_and_segments():
    assert media_kind("voice.ogg", "") == "audio"
    assert media_kind("movie.bin", "video/mp4") == "video"
    with pytest.raises(MediaError):
        media_kind("notes.txt", "text/plain")
    assert srt_time(3661.234) == "01:01:01,234"
    got = parse_google_segments('```json\n[{"start":1.5,"end":3,"text":"Привет","speaker":"A"}]\n```')
    assert got == [{"start": 1.5, "end": 3.0, "text": "Привет", "speaker": "A"}]
    assert transcript_text(got) == "[00:00:01] A: Привет"
    with pytest.raises(MediaError):
        parse_google_segments("not json")


@pytest.mark.asyncio
async def test_media_worker_creates_timestamped_artifacts(tmp_path: Path):
    settings = Settings(data_dir=tmp_path)
    db = Database(str(settings.db_path))
    await db.connect()
    await db._exec("INSERT INTO conversations (id,model,created_at,updated_at) VALUES ('c','openai:test',1,1)")
    source = tmp_path / "source.mp4"
    source.write_bytes(b"fake")
    att = await db.add_attachment("c", "meeting.mp4", "video/mp4", 4, str(source))
    worker = MediaWorker(db, settings)
    calls = []

    async def fake_run(jid, args):
        calls.append(args)
        if args[0] == "ffprobe":
            return "1200\n"
        work = Path(args[-1]).parent
        (work / "chunk_00000.ogg").write_bytes(b"a")
        (work / "chunk_00001.ogg").write_bytes(b"b")
        return ""

    async def fake_transcribe(job, path, seconds):
        return [{"start": 0, "end": min(seconds, 10), "text": f"часть {path.name}", "speaker": "A"}]

    worker._run = fake_run
    worker._transcribe = fake_transcribe
    await worker.start()
    job = await worker.submit("c", att["id"], "openai", "user-1", "test-key")
    done = await worker.wait(job["id"])
    assert done["status"] == "done" and done["progress"] == 1
    assert done["result"]["segments"] == 2 and done["result"]["duration"] == 1200
    assert len(done["result"]["attachments"]) == 3
    txt = next(x for x in done["result"]["attachments"] if x["filename"].endswith(".txt"))
    text = await db.get_attachment(txt["id"])
    assert "часть chunk_00000.ogg" in Path(text["path"]).read_text()
    srt = next(x for x in done["result"]["attachments"] if x["filename"].endswith(".srt"))
    srt_file = await db.get_attachment(srt["id"])
    assert "00:10:00,000 --> 00:10:10,000" in Path(srt_file["path"]).read_text()
    assert not (tmp_path / "media" / job["id"]).exists()
    await worker.stop()
    await db.close()


@pytest.mark.asyncio
async def test_media_job_cancel_and_restart_recovery(tmp_path: Path):
    settings = Settings(data_dir=tmp_path)
    db = Database(str(settings.db_path))
    await db.connect()
    await db._exec("INSERT INTO conversations (id,model,created_at,updated_at) VALUES ('c','openai:test',1,1)")
    source = tmp_path / "voice.ogg"
    source.write_bytes(b"fake")
    att = await db.add_attachment("c", "voice.ogg", "audio/ogg", 4, str(source))
    worker = MediaWorker(db, settings)
    job = await worker.submit("c", att["id"], "google", "user-1")
    cancelled = await worker.cancel(job["id"], "c")
    assert cancelled["status"] == "cancelled"
    with pytest.raises(MediaError, match="остановлена"):
        await worker.wait(job["id"])
    other = await db.create_media_job("c", att["id"], "transcribe", "google", "user-1")
    await db.update_media_job(other["id"], status="running", progress=0.5)
    await worker.start()
    recovered = await db.get_media_job(other["id"])
    assert recovered["status"] == "queued" and recovered["progress"] == 0
    await worker.stop()
    await db.close()


@pytest.mark.asyncio
async def test_remote_video_extracts_audio_archive(tmp_path: Path, monkeypatch):
    import io
    import tarfile
    import httpx

    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w") as tar:
        raw = b"opus-audio"
        info = tarfile.TarInfo("chunk_00000.ogg")
        info.size = len(raw)
        tar.addfile(info, io.BytesIO(raw))

    async def handler(request):
        assert request.read() == b"video"
        assert request.headers["Authorization"] == "Bearer space-token"
        assert request.headers["X-Deck-Media-Chunk-Seconds"] == "600"
        return httpx.Response(200, content=archive.getvalue(), headers={"Content-Type": "application/x-tar"})

    transport = httpx.MockTransport(handler)
    real_client = httpx.AsyncClient

    def client(*args, **kwargs):
        return real_client(transport=transport)

    monkeypatch.setattr("app.media.httpx.AsyncClient", client)
    monkeypatch.setattr("app.media.kgc.token", lambda: "space-token")
    source = tmp_path / "video.mp4"
    source.write_bytes(b"video")
    work = tmp_path / "work"
    work.mkdir()
    worker = MediaWorker(None, Settings(data_dir=tmp_path, keyguard_url="http://keyguard"))
    job = {"id": "j", "conversation_id": "c", "created_by": "u"}
    await worker._remote_extract(job, {"path": str(source)}, work)
    assert (work / "chunk_00000.ogg").read_bytes() == b"opus-audio"
    assert not (work / "audio.tar").exists()


def test_media_worker_extracts_real_audio(tmp_path: Path, monkeypatch):
    import shutil
    import subprocess
    import tarfile
    from fastapi.testclient import TestClient
    from app import media_worker

    if not shutil.which("ffmpeg"):
        pytest.skip("для проверки media-worker нужен FFmpeg")
    source = tmp_path / "source.mp4"
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1",
                    "-f", "lavfi", "-i", "sine=frequency=1000:duration=1", "-shortest", str(source)], check=True)
    monkeypatch.setattr(media_worker, "TOKEN", "worker-secret")
    monkeypatch.setattr(media_worker, "WORK_DIR", tmp_path)
    client = TestClient(media_worker.app)
    response = client.post("/extract", content=source.read_bytes(), headers={
        "Authorization": "Bearer worker-secret", "Content-Type": "application/octet-stream",
        "X-Deck-Media-Chunk-Seconds": "600"})
    assert response.status_code == 200, response.text
    archive = tmp_path / "answer.tar"
    archive.write_bytes(response.content)
    with tarfile.open(archive) as tar:
        assert [x.name for x in tar.getmembers()] == ["chunk_00000.ogg"]
        assert tar.extractfile("chunk_00000.ogg").read().startswith(b"OggS")
