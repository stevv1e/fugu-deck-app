"""Картинка для модели: уменьшенная копия (длинная сторона до 1600 px, JPEG).

Фото из галереи телефона весят 5–15 МБ — больше, чем модели принимают в одном запросе, и каждая такая картинка
отправляется заново на каждом шаге агента. Уменьшенная копия видна модели так же хорошо, а запрос дешевле.
Копии держатся в памяти (последние VISION_CACHE), исходный файл не меняется.
"""
from __future__ import annotations

import base64
import io
from collections import OrderedDict
from pathlib import Path

MAX_SIDE = 1600
SOURCE_MAX = 40 << 20  # больше — не открываем
# Сколько пикселей можно раскодировать целиком. У агента 512 МБ памяти: фото телефона на 108–200 Мп целиком —
# 300–600 МБ, и контейнер убивается посреди задания. JPEG раскодируется сразу уменьшенным (draft, масштаб 1/2–1/8
# средствами самого формата), поэтому предел касается только остальных форматов.
FULL_DECODE_MAX = 24_000_000
VISION_CACHE = 40
_cache: OrderedDict[str, str] = OrderedDict()


def for_model(key: str, path: Path) -> str | None:
    """data:-адрес уменьшенной картинки; None — файл не картинка или не читается."""
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]
    try:
        if path.stat().st_size > SOURCE_MAX:
            return None
        from PIL import Image, ImageOps

        Image.MAX_IMAGE_PIXELS = None  # размер проверяем сами — ниже, до раскодирования
        with Image.open(path) as im:
            if im.format == "JPEG":
                im.draft("RGB", (MAX_SIDE, MAX_SIDE))  # ближайший масштаб не меньше MAX_SIDE
            w, h = im.size
            if w * h > FULL_DECODE_MAX:
                return None
            im = ImageOps.exif_transpose(im)  # фото с телефона хранит поворот в EXIF
            if im.mode not in ("RGB", "L"):
                bg = Image.new("RGB", im.size, (255, 255, 255))
                rgba = im.convert("RGBA")
                bg.paste(rgba, mask=rgba.split()[-1])
                im = bg
            im.thumbnail((MAX_SIDE, MAX_SIDE))
            buf = io.BytesIO()
            im.convert("RGB").save(buf, "JPEG", quality=85, optimize=True)  # без EXIF: место съёмки модели ни к чему
    except Exception:
        return None
    url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    _cache[key] = url
    while len(_cache) > VISION_CACHE:
        _cache.popitem(last=False)
    return url
