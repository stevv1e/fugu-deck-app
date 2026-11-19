import json
from pathlib import Path

import pytest

from app.config import Settings
from app.db import Database
from app.media import MediaWorker, MediaError, media_kind, parse_google_segments, srt_time, transcript_text


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
