"""Service configuration, read from the environment and validated once at startup."""

from __future__ import annotations

from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from pydantic import Field, SecretStr, ValidationError, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from etl.domain.timestamps import load_zone
from etl.errors import ConfigError

LogLevel = Literal["debug", "info", "warning", "error"]


class Settings(BaseSettings):
    """Every tunable of the service. Names map one to one to upper-case environment variables."""

    model_config = SettingsConfigDict(
        env_file=None,
        case_sensitive=False,
        extra="ignore",
        frozen=True,
    )

    database_url: SecretStr
    # A run holds three connections at once: the run lock, the load transaction and the
    # bookkeeping writes (run record, rejects).
    database_pool_size: int = Field(default=5, ge=3, le=50)
    log_level: LogLevel = "info"

    report_dir: Path = Path("reports")
    reporting_zone: str = "UTC"

    max_reject_ratio: float = Field(default=0.05, ge=0.0, le=1.0)
    batch_size: int = Field(default=1000, ge=1, le=50_000)
    max_future_skew_seconds: int = Field(default=300, ge=0, le=86_400)

    @field_validator("database_url")
    @classmethod
    def _check_database_url(cls, value: SecretStr) -> SecretStr:
        parts = urlsplit(value.get_secret_value())
        if parts.scheme.split("+")[0] not in {"postgres", "postgresql"}:
            raise ValueError("must be a postgres:// or postgresql:// URL")
        return value

    @field_validator("reporting_zone")
    @classmethod
    def _check_zone(cls, value: str) -> str:
        load_zone(value)
        return value

    @field_validator("report_dir")
    @classmethod
    def _check_report_dir(cls, value: Path) -> Path:
        if value.exists() and not value.is_dir():
            raise ValueError(f"{value} exists and is not a directory")
        return value

    @property
    def reporting_tz(self) -> ZoneInfo:
        return load_zone(self.reporting_zone)


def _describe(error: ValidationError) -> list[str]:
    problems = []
    for item in error.errors():
        location = ".".join(str(part) for part in item["loc"]) or "settings"
        message = item["msg"].removeprefix("Value error, ")
        problems.append(f"{location.upper()}: {message}")
    return problems


def load_settings(**overrides: object) -> Settings:
    """Read the settings from the environment; raise ConfigError listing every problem."""
    try:
        return Settings(**overrides)  # type: ignore[arg-type]
    except ValidationError as error:
        raise ConfigError(_describe(error)) from None
