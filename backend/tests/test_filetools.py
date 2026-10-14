"""Что внутри вложения: архивы (с опасными путями и «бомбой»), документы, текст; создание файла агентом."""
import gzip
import io
import tarfile
import zipfile

import pytest
from openpyxl import Workbook

from app import filetools as ft


def make_zip(tmp_path, files: dict[str, bytes], name="a.zip"):
    p = tmp_path / name
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        for k, v in files.items():
            z.writestr(k, v)
    return p


def test_zip_listing_and_member(tmp_path):
    p = make_zip(tmp_path, {"src/main.py": b"print('hi')\n", "../../etc/passwd": b"root:x", "img.bin": b"\x00\x01\x02"})
    out = ft.read(p, "a.zip", "application/zip")
    assert ft.read(p, "a.zip", "", member="")["total"] == 3  # пустой path — список, а не ошибка
    assert out["total"] == 3 and {e["path"] for e in out["entries"]} == {"src/main.py", "../../etc/passwd", "img.bin"}
    assert ft.read(p, "a.zip", "", member="src/main.py")["content"] == "print('hi')\n"
    # «опасный» путь — только имя в архиве: читается его содержимое, на диск ничего не пишется
    assert ft.read(p, "a.zip", "", member="../../etc/passwd")["content"] == "root:x"
    assert ft.read(p, "a.zip", "", member="img.bin")["binary"]
    with pytest.raises(ft.FileError):
        ft.read(p, "a.zip", "", member="нет.txt")


def test_zip_bomb_is_capped(tmp_path, monkeypatch):
    monkeypatch.setattr(ft, "MAX_MEMBER_BYTES", 1 << 20)
    p = make_zip(tmp_path, {"big.txt": b"a" * (50 << 20)})  # 50 МБ сжимаются в десятки КБ
    assert p.stat().st_size < 200_000
    out = ft.read(p, "a.zip", "", member="big.txt")
    assert out["total_chars"] == 1 << 20 and out["truncated"] and out["cut_bytes"] == 1 << 20


def test_tar_and_gz(tmp_path):
    p = tmp_path / "a.tar.gz"
    with tarfile.open(p, "w:gz") as t:
        data = "привет, мир".encode()
        ti = tarfile.TarInfo("docs/readme.txt")
        ti.size = len(data)
        t.addfile(ti, io.BytesIO(data))
        link = tarfile.TarInfo("evil")
        link.type, link.linkname = tarfile.SYMTYPE, "/etc/shadow"
        t.addfile(link)
    out = ft.read(p, "a.tar.gz", "")
    assert out["kind"] == "tar" and out["total"] == 2
    assert ft.read(p, "a.tar.gz", "", member="docs/readme.txt")["content"] == "привет, мир"
    with pytest.raises(ft.FileError):
        ft.read(p, "a.tar.gz", "", member="evil")  # ссылка не разыменовывается
    g = tmp_path / "log.txt.gz"
    g.write_bytes(gzip.compress(b"line1\nline2\n"))
    assert ft.read(g, "log.txt.gz", "")["content"] == "line1\nline2\n"


def test_long_text_paging(tmp_path):
    p = tmp_path / "t.txt"
    p.write_text("x" * (ft.MAX_TEXT + 10))
    a = ft.read(p, "t.txt", "text/plain")
    assert a["truncated"] and a["next_offset"] == ft.MAX_TEXT
    b = ft.read(p, "t.txt", "text/plain", offset=a["next_offset"])
    assert b["content"] == "x" * 10 and "truncated" not in b


def test_docx_xlsx(tmp_path):
    doc = ('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           '<w:body><w:p><w:r><w:t>Договор</w:t></w:r></w:p><w:p><w:r><w:t>Сумма:</w:t><w:tab/><w:t>100</w:t></w:r></w:p>'
           '</w:body></w:document>').encode()
    d = make_zip(tmp_path, {"word/document.xml": doc}, "a.docx")
    assert ft.read(d, "a.docx", "")["content"] == "Договор\nСумма:\t100"
    bomb = ('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">&b;</w:document>').encode()
    with pytest.raises(Exception):
        ft.read(make_zip(tmp_path, {"word/document.xml": bomb}, "b.docx"), "b.docx", "")
    wb = Workbook()
    ws = wb.active
    ws.title = "Итоги"
    ws.append(["имя", "сумма"])
    ws.append(["Анна", 12.5])
    x = tmp_path / "a.xlsx"
    wb.save(x)
    out = ft.read(x, "a.xlsx", "")
    assert "лист «Итоги»" in out["content"] and "Анна\t12.5" in out["content"]


def test_pdf(tmp_path):
    # минимальный PDF с одной строкой текста
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            None, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    stream = b"BT /F1 12 Tf 20 100 Td (Hello PDF) Tj ET"
    out = io.BytesIO(b"%PDF-1.4\n")
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(out.tell())
        body = (f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream") if o is None else o.encode()
        out.write(f"{i} 0 obj\n".encode() + body + b"\nendobj\n")
    x = out.tell()
    out.write(f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode())
    for o in offs:
        out.write(f"{o:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n".encode())
    p = tmp_path / "a.pdf"
    p.write_bytes(out.getvalue())
    r = ft.read(p, "a.pdf", "application/pdf")
    assert r["pages"] == 1 and "Hello PDF" in r["content"]
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"%PDF-1.4 garbage")
    with pytest.raises(Exception):
        ft.read(bad, "bad.pdf", "")
