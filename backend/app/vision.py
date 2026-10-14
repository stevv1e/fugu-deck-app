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
# Вытянутые картинки (скриншоты длинных страниц, панорамы): при длинной стороне 1600 короткая стала бы узкой,
# и мелкий текст не прочесть. Короткая сторона — не меньше MIN_SHORT, но длинная — не больше LONG_CAP.
MIN_SHORT = 1024
LONG_CAP = 3072
SOURCE_MAX = 40 << 20  # больше — не открываем
# Сколько пикселей можно раскодировать целиком. У агента 512 МБ памяти: фото телефона на 108–200 Мп целиком —
# 300–600 МБ, и контейнер убивается посреди задания. JPEG раскодируется сразу уменьшенным (draft, масштаб 1/2–1/8
# средствами самого формата), поэтому предел касается только остальных форматов.
FULL_DECODE_MAX = 24_000_000
VISION_CACHE = 40
_cache: OrderedDict[str, str] = OrderedDict()


def target(w: int, h: int) -> tuple[int, int]:
    """Размер копии для модели: длинная сторона до MAX_SIDE, но короткая не уже MIN_SHORT (пока длинная ≤ LONG_CAP)."""
    long, short = max(w, h), min(w, h)
    k = min(1.0, max(MAX_SIDE / long, min(MIN_SHORT / short, LONG_CAP / long)))
    return max(1, round(w * k)), max(1, round(h * k))


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
            want = target(*im.size)
            if im.format == "JPEG":
                im.draft("RGB", want)  # ближайший масштаб раскодирования не меньше нужного размера
            w, h = im.size
            if w * h > FULL_DECODE_MAX:
                return None
            landscape = w >= h
            im = ImageOps.exif_transpose(im)  # фото с телефона хранит поворот в EXIF
            if (im.size[0] >= im.size[1]) != landscape:
                want = (want[1], want[0])  # повёрнуто на 90°: ширина и высота поменялись местами
            if im.mode not in ("RGB", "L"):
                bg = Image.new("RGB", im.size, (255, 255, 255))
                rgba = im.convert("RGBA")
                bg.paste(rgba, mask=rgba.split()[-1])
                im = bg
            if im.size[0] > want[0]:  # меньше нужного не растягиваем
                im = im.resize(want, Image.LANCZOS)
            buf = io.BytesIO()
            im.convert("RGB").save(buf, "JPEG", quality=85, optimize=True)  # без EXIF: место съёмки модели ни к чему
    except Exception:
        return None
    url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    _cache[key] = url
    while len(_cache) > VISION_CACHE:
        _cache.popitem(last=False)
    return url
