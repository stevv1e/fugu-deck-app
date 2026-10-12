"""Команды на серверах через ssh-gateway (сторона агента) — сценарий в отдельном процессе: tests/ssh_gateway_check.py."""
import subprocess
import sys
from pathlib import Path


def test_agent_ssh_commands_via_gateway():
    r = subprocess.run([sys.executable, str(Path(__file__).with_name("ssh_gateway_check.py"))], capture_output=True, text=True, timeout=120)
    assert r.returncode == 0 and "ssh-tools: ok" in r.stdout, r.stdout[-2000:] + r.stderr[-3000:]
