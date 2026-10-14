"""Что внутри вложения: текст документа (PDF, DOCX, XLSX), список и файлы архива (zip, tar, gz).

Архив не распаковывается на диск: файл читается из архива в память с пределом, имя члена архива — только ключ
поиска. Поэтому пути вида «../../etc/passwd» внутри архива ничего не дают, а «архивная бомба» упирается в предел
чтения. XML документов разбирается defusedxml (без внешних сущностей и «миллиарда смешков»).
"""
from __future__ import annotations

import gzip
import io
import tarfile
import zipfile
from pathlib import Path

from defusedxml import ElementTree as SafeET

MAX_TEXT = 60_000            # символов за один вызов (дальше — offset)
MAX_MEMBER_BYTES = 20 << 20  # сколько читаем из одного файла архива или документа
MAX_LIST = 1000              # строк списка архива за один вызов
MAX_PDF_PAGES = 400
MAX_XLSX_ROWS = 20_000

ARCHIVE_EXT = (".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".gz", ".jar", ".apk")


class FileError(ValueError):
    pass


def kind_of(filename: str, mime: str = "") -> str:
    n = filename.lower()
    if n.endswith((".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz")):
        return "tar"
    if n.endswith((".zip", ".jar", ".apk")) or mime == "application/zip":
        return "zip"
    if n.endswith(".gz") or mime == "application/gzip":
        return "gz"
    if n.endswith(".pdf") or mime == "application/pdf":
        return "pdf"
    if n.endswith(".docx"):
        return "docx"
    if n.endswith((".xlsx", ".xlsm")):
        return "xlsx"
    if mime.startswith("image/"):
        return "image"
    return "text"


def _capped(f, limit: int | None = None) -> tuple[bytes, bool]:
    limit = MAX_MEMBER_BYTES if limit is None else limit
    data = f.read(limit + 1)
    return data[:limit], len(data) > limit


def _decode(raw: bytes) -> str | None:
    if b"\x00" in raw[:8192]:
        return None
    for enc in ("utf-8", "cp1251"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return None


def _page(text: str, offset: int, extra: dict) -> dict:
    chunk = text[offset:offset + MAX_TEXT]
    out = {**extra, "content": chunk, "total_chars": len(text), "offset": offset}
    if offset + MAX_TEXT < len(text):
        out["truncated"] = True
        out["next_offset"] = offset + MAX_TEXT
        out["hint"] = "Дочитайте следующий кусок с offset=next_offset"
    return out


# ------------------------------------------------------------------ архивы
def list_archive(path: Path, kind: str, start: int = 0) -> dict:
    entries: list[dict] = []
    total = 0
    if kind == "zip":
        with zipfile.ZipFile(path) as z:
            for i in z.infolist():
                total += 1
                if start < total <= start + MAX_LIST:
                    entries.append({"path": i.filename, "size": i.file_size, "dir": i.is_dir()})
    elif kind == "tar":
        with tarfile.open(path, "r:*") as t:
            for m in t:
                total += 1
                if start < total <= start + MAX_LIST:
                    entries.append({"path": m.name, "size": m.size, "dir": m.isdir(),
                                    **({"link": True} if m.issym() or m.islnk() else {})})
    elif kind == "gz":
        name = path.name[:-3] if path.name.lower().endswith(".gz") else path.name
        return {"kind": "gz", "entries": [{"path": name.split("_", 1)[-1], "size": None, "dir": False}], "total": 1,
                "hint": "Одиночный файл gzip: читайте read_attachment без path"}
    else:
        raise FileError("это не архив")
    out = {"kind": kind, "entries": entries, "total": total}
    if total > start + MAX_LIST:
        out["truncated"] = True
        out["next_start"] = start + MAX_LIST
    return out


def read_member(path: Path, kind: str, member: str) -> tuple[bytes, bool]:
    if kind == "zip":
        with zipfile.ZipFile(path) as z:
            try:
                info = z.getinfo(member)
            except KeyError:
                raise FileError(f"в архиве нет файла {member!r}")
            if info.is_dir():
                raise FileError(f"{member!r} — папка")
            with z.open(info) as f:
                return _capped(f)
    if kind == "tar":
        with tarfile.open(path, "r:*") as t:
            try:
                m = t.getmember(member)
            except KeyError:
                raise FileError(f"в архиве нет файла {member!r}")
            if not m.isfile():
                raise FileError(f"{member!r} — не обычный файл (папка или ссылка)")
            f = t.extractfile(m)
            if f is None:
                raise FileError(f"{member!r} не читается")
            return _capped(f)
    raise FileError("это не архив")


# ------------------------------------------------------------------ документы
def pdf_text(raw: bytes) -> tuple[str, dict]:
    from pypdf import PdfReader

    r = PdfReader(io.BytesIO(raw))
    if r.is_encrypted:
        try:
            r.decrypt("")
        except Exception:
            raise FileError("PDF защищён паролем")
    pages = len(r.pages)
    parts = []
    for i, p in enumerate(r.pages[:MAX_PDF_PAGES]):
        try:
            t = p.extract_text() or ""
        except Exception:
            t = ""
        parts.append(f"--- страница {i + 1} ---\n{t.strip()}")
    text = "\n\n".join(parts)
    meta = {"pages": pages}
    if pages > MAX_PDF_PAGES:
        meta["pages_read"] = MAX_PDF_PAGES
    if not text.replace("--- страница", "").strip(" -0123456789\n"):
        meta["hint"] = "Текста в PDF нет — вероятно, это скан (картинки). Распознавание текста пока не поддерживается."
    return text, meta


W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def docx_text(raw: bytes) -> tuple[str, dict]:
    try:
        z = zipfile.ZipFile(io.BytesIO(raw))
        with z.open("word/document.xml") as f:
            xml, cut = _capped(f)
    except (zipfile.BadZipFile, KeyError):
        raise FileError("файл DOCX повреждён")
    if cut:
        raise FileError("документ слишком большой")
    root = SafeET.fromstring(xml)
    lines = []
    for p in root.iter(W + "p"):
        t = "".join((n.text or "") if n.tag == W + "t" else "\t" if n.tag == W + "tab" else "" for n in p.iter())
        lines.append(t)
    return "\n".join(lines).strip(), {}


def xlsx_text(raw: bytes) -> tuple[str, dict]:
    from openpyxl import load_workbook

    try:
        wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    except Exception:
        raise FileError("файл XLSX повреждён")
    out, rows_total = [], 0
    for ws in wb.worksheets:
        out.append(f"=== лист «{ws.title}» ===")
        for row in ws.iter_rows(values_only=True):
            rows_total += 1
            if rows_total > MAX_XLSX_ROWS:
                break
            cells = ["" if v is None else str(v) for v in row]
            while cells and cells[-1] == "":
                cells.pop()
            if cells:
                out.append("\t".join(cells))
        if rows_total > MAX_XLSX_ROWS:
            out.append(f"… дальше не прочитано (больше {MAX_XLSX_ROWS} строк)")
            break
    wb.close()
    return "\n".join(out), {"sheets": len(wb.worksheets)}


def text_of(name: str, raw: bytes, cut: bool) -> tuple[str | None, dict]:
    """Текст файла по его виду; None — бинарный файл, текста нет."""
    k = kind_of(name)
    meta: dict = {"kind": k}
    if k in ("pdf", "docx", "xlsx"):
        if cut:
            raise FileError(f"файл больше {MAX_MEMBER_BYTES >> 20} МБ — документ такого размера не разбирается")
        text, m = {"pdf": pdf_text, "docx": docx_text, "xlsx": xlsx_text}[k](raw)
        return text, {**meta, **m}
    if k == "gz":
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as g:
            raw, cut2 = _capped(g)
        return text_of(name[:-3], raw, cut or cut2)
    text = _decode(raw)
    if cut and text is not None:
        meta["cut_bytes"] = MAX_MEMBER_BYTES
    return text, meta


def read(path: Path, filename: str, mime: str, member: str | None = None, offset: int = 0, start: int = 0) -> dict:
    """То, что видит агент через read_attachment."""
    k = kind_of(filename, mime)
    base = {"filename": filename}
    member = (member or "").strip() or None  # пустой path (модели так делают) — это «покажи список»
    try:
        if k in ("zip", "tar") and member is None:
            return {**base, **list_archive(path, k, start),
                    "hint": "Прочитать файл из архива — read_attachment с path=<путь из списка>"}
        if member is not None:
            if k not in ("zip", "tar"):
                raise FileError("path задаётся только для архивов zip и tar")
            raw, cut = read_member(path, k, member)
            text, meta = text_of(member, raw, cut)
            base["path"] = member
        else:
            if k == "image":
                return {**base, "kind": "image", "size": path.stat().st_size,
                        "hint": "Картинку модель видит в сообщении пользователя; прочитать её как текст нельзя"}
            with path.open("rb") as f:
                raw, cut = _capped(f)
            text, meta = text_of(filename, raw, cut)
    except (zipfile.BadZipFile, tarfile.TarError, gzip.BadGzipFile, EOFError) as e:
        raise FileError(f"архив повреждён: {e}")
    if text is None:
        return {**base, **meta, "binary": True, "size": len(raw),
                "hint": "Двоичный файл: его можно закоммитить через commit_files с attachment_id"}
    return _page(text, max(0, offset), {**base, **meta})
