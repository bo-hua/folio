"""Data-directory location and the tiny config.toml.

Everything user-owned lives under one data directory (default ~/.cc-workspace):

    config.toml        repo path + bind address
    items/<Area>/*.md  durable work items (Markdown, source of truth)
    runtime/sessions/  ephemeral Claude session state written by the hook
"""
from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

DEFAULT_DATA_DIR = Path.home() / ".cc-workspace"
DEFAULT_BIND = "127.0.0.1:4317"
ENV_DATA_DIR = "FOLIO_DATA_DIR"


@dataclass
class Config:
    data_dir: Path
    repo: Path | None
    bind: str = DEFAULT_BIND

    @property
    def items_dir(self) -> Path:
        return self.data_dir / "items"

    @property
    def runtime_dir(self) -> Path:
        return self.data_dir / "runtime"

    @property
    def config_path(self) -> Path:
        return self.data_dir / "config.toml"


def resolve_data_dir(cli_value: str | None = None) -> Path:
    """CLI flag > FOLIO_DATA_DIR env var > ~/.cc-workspace."""
    value = cli_value or os.environ.get(ENV_DATA_DIR)
    return Path(value).expanduser().resolve() if value else DEFAULT_DATA_DIR


def load_config(data_dir: Path) -> Config:
    path = data_dir / "config.toml"
    raw: dict = {}
    if path.exists():
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    repo = raw.get("repo")
    return Config(
        data_dir=data_dir,
        repo=Path(repo).expanduser() if repo else None,
        bind=str(raw.get("bind") or DEFAULT_BIND),
    )


def _toml_str(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def write_config(data_dir: Path, repo: Path, bind: str = DEFAULT_BIND) -> Path:
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / "config.toml"
    text = (
        "# folio configuration. Edit freely; the server reads this at startup.\n"
        "# The ONE git repository whose worktrees and Claude sessions folio tracks.\n"
        f"repo = {_toml_str(str(repo))}\n"
        "# Address the web server binds to. Keep it on loopback; reach it over SSH -L.\n"
        f"bind = {_toml_str(bind)}\n"
    )
    path.write_text(text, encoding="utf-8")
    return path
