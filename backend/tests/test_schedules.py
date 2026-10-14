"""Задания по расписанию: сроки (часовые пояса, дни недели, переход времени), проход планировщика, уборка вложений."""
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app import schedules as sched
from app.db import DEFAULT_PROJECT, Database

ALMATY = ZoneInfo("Asia/Almaty")


def ts(y, mo, d, h, mi, tz=ALMATY):
    return datetime(y, mo, d, h, mi, tzinfo=tz).timestamp()


def test_next_run_daily_weekly_hourly_once():
    base = {"tz": "Asia/Almaty", "at_time": "09:30", "weekdays": []}
    after = ts(2026, 10, 14, 10, 0)  # среда, 10:00 по Алматы
    assert sched.next_run({**base, "kind": "daily"}, after) == ts(2026, 10, 15, 9, 30)
    assert sched.next_run({**base, "kind": "daily"}, ts(2026, 10, 14, 9, 0)) == ts(2026, 10, 14, 9, 30)
    # пн и пт → ближайшая пятница
    assert sched.next_run({**base, "kind": "weekly", "weekdays": [0, 4]}, after) == ts(2026, 10, 16, 9, 30)
    # только среда, уже прошло → через неделю
    assert sched.next_run({**base, "kind": "weekly", "weekdays": [2]}, after) == ts(2026, 10, 21, 9, 30)
    assert sched.next_run({**base, "kind": "hourly", "at_time": "00:15"}, after) == ts(2026, 10, 14, 10, 15)
    assert sched.next_run({**base, "kind": "hourly", "at_time": "00:00"}, after) == ts(2026, 10, 14, 11, 0)
    once = {**base, "kind": "once", "run_at": after + 60}
    assert sched.next_run(once, after) == after + 60
    assert sched.next_run({**once, "last_run_at": after}, after) is None
    assert sched.next_run(once, after + 120) is None


def test_next_run_dst():
    # Берлин, 25.10.2026 — переход на зимнее время: «каждый день в 09:00» остаётся 09:00 по местному
    b = ZoneInfo("Europe/Berlin")
    s = {"kind": "daily", "at_time": "09:00", "tz": "Europe/Berlin", "weekdays": []}
    first = sched.next_run(s, ts(2026, 10, 24, 8, 0, b))
    second = sched.next_run(s, first)
    assert datetime.fromtimestamp(first, b).hour == 9 and datetime.fromtimestamp(second, b).hour == 9
    assert second - first == 25 * 3600


def test_validate():
    sched.validate("daily", "23:59", [], "Europe/Moscow", None)
    for bad in [("daily", "24:00", [], "UTC", None), ("weekly", "09:00", [], "UTC", None),
                ("weekly", "09:00", [7], "UTC", None), ("weekly", "09:00", [1, 1], "UTC", None),
                ("daily", "09:00", [], "Mars/Olympus", None), ("once", "09:00", [], "UTC", None),
                ("yearly", "09:00", [], "UTC", None)]:
        with pytest.raises(sched.ScheduleError):
            sched.validate(*bad)
    assert sched.describe({"kind": "weekly", "weekdays": [4, 0], "at_time": "08:00"}) == "пн, пт в 08:00"
    assert sched.describe({"kind": "hourly", "at_time": "00:05"}) == "каждый час в :05"


async def test_scheduler_runs_due_once_and_moves_on(tmp_path):
    db = Database(str(tmp_path / "t.sqlite3"))
    await db.connect()
    try:
        now = time.time()
        s = await db.create_schedule(project_id=DEFAULT_PROJECT, created_by=None, title="t", prompt="p", model="m",
                                     kind="daily", at_time="09:00", weekdays=[], tz="UTC", next_at=now - 5)
        later = await db.create_schedule(project_id=DEFAULT_PROJECT, created_by=None, title="t2", prompt="p", model="m",
                                         kind="daily", at_time="09:00", weekdays=[], tz="UTC", next_at=now + 3600)
        once = await db.create_schedule(project_id=DEFAULT_PROJECT, created_by=None, title="o", prompt="p", model="m",
                                        kind="once", run_at=now - 1, next_at=now - 1)
        fired = []

        async def fire(x):
            fired.append(x["id"])
            if x["id"] == once["id"]:
                raise RuntimeError("сбой")
            return "запущено"

        sc = sched.Scheduler(db, fire)
        assert await sc.run_due(now) == 2
        assert sorted(fired) == sorted([s["id"], once["id"]])
        assert await sc.run_due(now + 1) == 0  # пропущенные не копятся и не повторяются
        a = await db.get_schedule(s["id"])
        assert a["next_at"] > now and a["last_status"] == "запущено"
        o = await db.get_schedule(once["id"])
        assert o["next_at"] is None and o["last_status"].startswith("ошибка")
        assert await db.next_schedule_at() == min(a["next_at"], later["next_at"])
        await db.update_schedule(later["id"], enabled=False)
        assert await db.next_schedule_at() == a["next_at"]
    finally:
        await db.close()


async def test_unsent_attachments(tmp_path):
    db = Database(str(tmp_path / "t.sqlite3"))
    await db.connect()
    try:
        c = await db.create_conversation("m", DEFAULT_PROJECT, None)
        sent = await db.add_attachment(c["id"], "a.png", "image/png", 1, "/x/a")
        unsent = await db.add_attachment(c["id"], "b.png", "image/png", 1, "/x/b")
        await db.add_message(c["id"], "user", "вот", meta={"attachments": [{"id": sent["id"]}]})
        assert await db.unsent_attachments(time.time() - 3600) == []  # ещё свежие
        rows = await db.unsent_attachments(time.time() + 1)
        assert [r["id"] for r in rows] == [unsent["id"]]
        await db.delete_attachments([unsent["id"]])
        assert await db.get_attachment(unsent["id"]) is None and await db.get_attachment(sent["id"])
    finally:
        await db.close()
