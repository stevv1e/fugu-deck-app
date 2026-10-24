"""Все инструменты агента регистрируются при импорте модулей ниже."""
from . import agent_tools, memory_tools, orchestration, repo_tools, skill_tools, ssh_tools, web_tools  # noqa: F401
from .registry import REGISTRY, ApprovalPolicy, ToolContext  # noqa: F401
