from __future__ import annotations

import pytest

from authz.config import ConfigError, load_settings

SECRET = "s" * 40
BASE_ENV = {
    "DATABASE_URL": "postgres://app:pw@localhost:5432/app",
    "REDIS_URL": "redis://localhost:6379/0",
    "JWT_SECRETS": SECRET,
}


@pytest.fixture
def env(monkeypatch):
    for key in ("DATABASE_URL", "REDIS_URL", "JWT_SECRETS", "ENVIRONMENT", "PUBLIC_BASE_URL"):
        monkeypatch.delenv(key, raising=False)
    for key, value in BASE_ENV.items():
        monkeypatch.setenv(key, value)
    return monkeypatch


def test_reads_the_environment(env):
    env.setenv("JWT_SECRETS", f"{'n' * 32}, {'o' * 32}")
    env.setenv("ACCESS_TOKEN_TTL_SECONDS", "600")

    settings = load_settings()

    assert settings.jwt_secret_values == ("n" * 32, "o" * 32)
    assert settings.access_token_ttl_seconds == 600
    assert settings.database_url.get_secret_value() == BASE_ENV["DATABASE_URL"]


def test_lists_every_problem(env):
    env.delenv("DATABASE_URL")
    env.setenv("REDIS_URL", "http://localhost")
    env.setenv("PORT", "70000")

    with pytest.raises(ConfigError) as caught:
        load_settings()

    problems = "\n".join(caught.value.problems)
    assert "DATABASE_URL" in problems
    assert "REDIS_URL" in problems
    assert "PORT" in problems


def test_short_secrets_are_refused(env):
    env.setenv("JWT_SECRETS", f"{SECRET},short")

    with pytest.raises(ConfigError, match="secret #2"):
        load_settings()


def test_access_tokens_must_be_shorter_lived_than_refresh_tokens(env):
    env.setenv("ACCESS_TOKEN_TTL_SECONDS", "3600")
    env.setenv("REFRESH_TOKEN_TTL_SECONDS", "3600")

    with pytest.raises(ConfigError, match="access_token_ttl_seconds"):
        load_settings()


def test_production_requires_https(env):
    env.setenv("ENVIRONMENT", "production")
    env.setenv("PUBLIC_BASE_URL", "http://authz.example.com")

    with pytest.raises(ConfigError, match="https"):
        load_settings()


def test_error_message_never_contains_secrets(env):
    env.setenv("JWT_SECRETS", "tiny-secret-value")

    with pytest.raises(ConfigError) as caught:
        load_settings()

    assert "tiny-secret-value" not in str(caught.value)
