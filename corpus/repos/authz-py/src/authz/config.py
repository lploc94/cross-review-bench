"""Service configuration, read from the environment and validated once at startup."""

from __future__ import annotations

from functools import cached_property
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, ValidationError, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

LogLevel = Literal["debug", "info", "warning", "error"]
MailBackend = Literal["log", "smtp"]

MIN_SECRET_LENGTH = 32


class ConfigError(Exception):
    """Raised when the environment does not describe a usable configuration."""

    def __init__(self, problems: list[str]) -> None:
        self.problems = problems
        super().__init__("invalid configuration:\n" + "\n".join(f"  - {p}" for p in problems))


class Settings(BaseSettings):
    """Every tunable of the service. Names map one to one to upper-case environment variables."""

    model_config = SettingsConfigDict(
        env_file=None,
        case_sensitive=False,
        extra="ignore",
        frozen=True,
    )

    environment: Literal["development", "test", "production"] = "development"
    host: str = "0.0.0.0"  # noqa: S104 - the service is meant to listen on every interface
    port: int = Field(default=8000, ge=1, le=65535)
    log_level: LogLevel = "info"

    database_url: SecretStr
    database_pool_size: int = Field(default=10, ge=1, le=200)
    database_echo: bool = False
    redis_url: SecretStr

    jwt_secrets: Annotated[list[SecretStr], NoDecode]
    jwt_issuer: str = "authz"
    jwt_leeway_seconds: int = Field(default=5, ge=0, le=300)
    access_token_ttl_seconds: int = Field(default=900, ge=30, le=86_400)
    refresh_token_ttl_seconds: int = Field(default=30 * 86_400, ge=300, le=365 * 86_400)
    session_ttl_seconds: int = Field(default=90 * 86_400, ge=300, le=365 * 86_400)

    argon2_time_cost: int = Field(default=3, ge=1, le=20)
    argon2_memory_cost_kib: int = Field(default=65_536, ge=8, le=4_194_304)
    argon2_parallelism: int = Field(default=4, ge=1, le=64)

    login_rate_limit: int = Field(default=10, ge=1, le=10_000)
    login_rate_window_seconds: int = Field(default=300, ge=1, le=86_400)
    refresh_rate_limit: int = Field(default=60, ge=1, le=100_000)
    refresh_rate_window_seconds: int = Field(default=60, ge=1, le=86_400)

    invitation_ttl_seconds: int = Field(default=7 * 86_400, ge=60, le=90 * 86_400)
    public_base_url: str = "http://localhost:8000"

    trust_proxy_headers: bool = False

    mail_backend: MailBackend = "log"
    mail_from: str = "no-reply@example.com"
    smtp_host: str = "localhost"
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_username: str | None = None
    smtp_password: SecretStr | None = None
    smtp_starttls: bool = True

    @field_validator("jwt_secrets", mode="before")
    @classmethod
    def _split_secrets(cls, value: object) -> object:
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]
        return value

    @field_validator("jwt_secrets")
    @classmethod
    def _check_secrets(cls, value: list[SecretStr]) -> list[SecretStr]:
        if not value:
            raise ValueError("at least one secret is required")
        for index, secret in enumerate(value):
            if len(secret.get_secret_value()) < MIN_SECRET_LENGTH:
                raise ValueError(
                    f"secret #{index + 1} is shorter than {MIN_SECRET_LENGTH} characters"
                )
        return value

    @field_validator("database_url")
    @classmethod
    def _check_database_url(cls, value: SecretStr) -> SecretStr:
        scheme = urlsplit(value.get_secret_value()).scheme
        if scheme.split("+")[0] not in {"postgres", "postgresql"}:
            raise ValueError("must be a postgres:// or postgresql:// URL")
        return value

    @field_validator("redis_url")
    @classmethod
    def _check_redis_url(cls, value: SecretStr) -> SecretStr:
        if urlsplit(value.get_secret_value()).scheme not in {"redis", "rediss", "unix"}:
            raise ValueError("must be a redis://, rediss:// or unix:// URL")
        return value

    @field_validator("public_base_url")
    @classmethod
    def _check_base_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if parts.scheme not in {"http", "https"} or not parts.netloc:
            raise ValueError("must be an absolute http(s) URL")
        return value.rstrip("/")

    @model_validator(mode="after")
    def _check_relations(self) -> Settings:
        problems: list[str] = []
        if self.access_token_ttl_seconds >= self.refresh_token_ttl_seconds:
            problems.append("access_token_ttl_seconds must be shorter than the refresh token TTL")
        if self.refresh_token_ttl_seconds > self.session_ttl_seconds:
            problems.append("refresh_token_ttl_seconds must not exceed session_ttl_seconds")
        if self.argon2_memory_cost_kib < 8 * self.argon2_parallelism:
            problems.append("argon2_memory_cost_kib must be at least 8 * argon2_parallelism")
        if self.mail_backend == "smtp" and not self.smtp_host:
            problems.append("smtp_host is required when mail_backend is smtp")
        if self.environment == "production" and not self.public_base_url.startswith("https://"):
            problems.append("public_base_url must use https in production")
        if problems:
            raise ValueError("; ".join(problems))
        return self

    @cached_property
    def jwt_secret_values(self) -> tuple[str, ...]:
        """Plain secrets, the signing secret first."""
        return tuple(secret.get_secret_value() for secret in self.jwt_secrets)


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
