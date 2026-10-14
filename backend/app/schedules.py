"""Задания агента по расписанию: каждый час, каждый день, по дням недели или один раз.

Задание — это сообщение агенту в его собственный чат проекта («⏰ <название>»), отправленное в назначенное время от
имени того, кто задание создал. Пропущенные запуски (пространство спало, сервер перезапускался) не копятся: после
пробуждения задание выполняется один раз, и следующий срок считается от текущего момента. В кластере спящее
пространство будит control-plane: перед сном он спрашивает у агента ближайший срок (/api/health, next_wake).
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta
from typing import Awaitable, Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

log = logging.getLogger("fugu.deck.schedules")

KINDS = ("hourly", "daily", "weekly", "once")
WEEKDAYS = ("пн", "вт", "ср", "чт", "пт", "сб", "вс")
MAX_PER_PROJECT = 20


class ScheduleError(ValueError):
    pass


def zone(tz: str) -> ZoneInfo:
    try:
        return ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        raise ScheduleError(f"Неизвестный часовой пояс {tz!r}")


def parse_hhmm(s: str) -> tuple[int, int]:
    try:
        h, m = s.split(":")
        h, m = int(h), int(m)
    except ValueError:
        raise ScheduleError("Время — в виде ЧЧ:ММ")
    if not (0 <= h < 24 and 0 <= m < 60):
        raise ScheduleError("Время — в виде ЧЧ:ММ")
    return h, m


def validate(kind: str, at_time: str, weekdays: list[int], tz: str, run_at: float | None) -> None:
    if kind not in KINDS:
        raise ScheduleError("Повтор: hourly | daily | weekly | once")
    zone(tz)
    if kind != "once":
        parse_hhmm(at_time)  # у «каждый час» значат только минуты
    if kind == "weekly" and (not weekdays or any(d not in range(7) for d in weekdays) or len(set(weekdays)) != len(weekdays)):
        raise ScheduleError("Дни недели: от 0 (пн) до 6 (вс), без повторов")
    if kind == "once" and not run_at:
        raise ScheduleError("Для разового задания нужна дата и время")


def next_run(s: dict, after: float) -> float | None:
    """Ближайший срок строго позже after (unix). None — заданий больше не будет (разовое уже выполнено)."""
    kind = s["kind"]
    if kind == "once":
        ra = s.get("run_at")
        return ra if ra and ra > after and not s.get("last_run_at") else None
    tz = zone(s.get("tz") or "UTC")
    now = datetime.fromtimestamp(after, tz)
    if kind == "hourly":
        minute = parse_hhmm(s.get("at_time") or "00:00")[1]
        c = now.replace(minute=minute, second=0, microsecond=0)
        if c.timestamp() <= after:
            c += timedelta(hours=1)
        return c.timestamp()
    h, m = parse_hhmm(s.get("at_time") or "09:00")
    days = set(s.get("weekdays") or []) if kind == "weekly" else set(range(7))
    for i in range(8):
        d = (now + timedelta(days=i)).date()
        if d.weekday() not in days:
            continue
        # Через переход на летнее время: «стенное» время в поясе, переведённое в unix (fold=0 — первое из двух).
        c = datetime(d.year, d.month, d.day, h, m, tzinfo=tz)
        if c.timestamp() > after:
            return c.timestamp()
    return None


def describe(s: dict) -> str:
    kind = s["kind"]
    if kind == "hourly":
        return f"каждый час в :{parse_hhmm(s.get('at_time') or '00:00')[1]:02d}"
    if kind == "daily":
        return f"каждый день в {s['at_time']}"
    if kind == "weekly":
        return ", ".join(WEEKDAYS[d] for d in sorted(s.get("weekdays") or [])) + f" в {s['at_time']}"
    tz = zone(s.get("tz") or "UTC")
    return "один раз " + datetime.fromtimestamp(s["run_at"], tz).strftime("%d.%m.%Y %H:%M")


class Scheduler:
    """Раз в tick секунд выполняет задания, чей срок наступил. fire(s) запускает агента и возвращает итог строкой."""

    def __init__(self, db, fire: Callable[[dict], Awaitable[str]], tick: float = 20.0):
        self.db, self.fire, self.tick = db, fire, tick
        self.task: asyncio.Task | None = None

    def start(self) -> None:
        self.task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self.task:
            self.task.cancel()

    async def _loop(self) -> None:
        while True:
            try:
                await self.run_due()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("ошибка прохода расписания")
            await asyncio.sleep(self.tick)

    async def run_due(self, now: float | None = None) -> int:
        now = now or time.time()
        n = 0
        for s in await self.db.due_schedules(now):
            # Следующий срок — до запуска: упадём посреди него — задание не повторится в цикле.
            await self.db.update_schedule(s["id"], next_at=next_run({**s, "last_run_at": now}, now), last_run_at=now)
            try:
                status = await self.fire(s)
            except Exception as e:  # отказ одного задания не мешает остальным
                log.warning("задание %s не запущено: %s", s["id"], e)
                status = f"ошибка: {e}"
            await self.db.update_schedule(s["id"], last_status=status[:300])
            n += 1
        return n
