"""Общий чат в кластере (спонсорство через keyguard) — сценарий в отдельном процессе: tests/team_kg_check.py."""
import subprocess
import sys
from pathlib import Path


def test_team_chat_sponsorship_via_keyguard():
    r = subprocess.run([sys.executable, str(Path(__file__).with_name("team_kg_check.py"))], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0 and "team-kg: ok" in r.stdout, r.stdout[-2000:] + r.stderr[-3000:]
