"""Builds every adapter and service from the settings; the app and the CLI share it."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from redis.asyncio import Redis

from authz.config import Settings
from authz.infra.clock import Clock, SystemClock
from authz.infra.db import Database
from authz.infra.hashing import HashParameters, PasswordHasher
from authz.infra.mailer import LogMailer, Mailer, SmtpMailer, SmtpOptions
from authz.infra.randomness import RandomSource, SecureRandom
from authz.infra.rate_limiter import FixedWindowRateLimiter, RateLimiter, RateLimitRule
from authz.infra.redis import create_redis, ping
from authz.services.audit import AuditLog, AuditQueryService
from authz.services.auth import AuthPolicy, AuthService
from authz.services.authorization import AuthorizationService
from authz.services.health import HealthService
from authz.services.invitations import InvitationPolicy, InvitationService
from authz.services.members import MemberService
from authz.services.organizations import OrganizationService
from authz.services.projects import ProjectService
from authz.services.roles import RoleService
from authz.services.tokens import AccessTokenCodec
from authz.services.users import SessionService, UserService


@dataclass(slots=True)
class Container:
    settings: Settings
    clock: Clock
    random: RandomSource
    db: Database
    redis: Redis
    mailer: Mailer
    hasher: PasswordHasher
    limiter: RateLimiter
    tokens: AccessTokenCodec
    audit_log: AuditLog
    authz: AuthorizationService
    auth: AuthService
    users: UserService
    sessions: SessionService
    organizations: OrganizationService
    roles: RoleService
    members: MemberService
    projects: ProjectService
    invitations: InvitationService
    audit: AuditQueryService
    health: HealthService

    async def aclose(self) -> None:
        await self.redis.aclose()
        await self.db.dispose()


def build_mailer(settings: Settings) -> Mailer:
    if settings.mail_backend == "smtp":
        password = settings.smtp_password.get_secret_value() if settings.smtp_password else None
        return SmtpMailer(
            SmtpOptions(
                host=settings.smtp_host,
                port=settings.smtp_port,
                sender=settings.mail_from,
                username=settings.smtp_username,
                password=password,
                starttls=settings.smtp_starttls,
            )
        )
    return LogMailer()


def build_container(
    settings: Settings,
    *,
    clock: Clock | None = None,
    random: RandomSource | None = None,
    mailer: Mailer | None = None,
) -> Container:
    clock = clock or SystemClock()
    random = random or SecureRandom()
    mailer = mailer or build_mailer(settings)
    db = Database(
        settings.database_url.get_secret_value(),
        pool_size=settings.database_pool_size,
        echo=settings.database_echo,
    )
    redis = create_redis(settings.redis_url.get_secret_value())
    hasher = PasswordHasher(
        HashParameters(
            time_cost=settings.argon2_time_cost,
            memory_cost_kib=settings.argon2_memory_cost_kib,
            parallelism=settings.argon2_parallelism,
        )
    )
    limiter = FixedWindowRateLimiter(redis, clock)
    tokens = AccessTokenCodec(
        settings.jwt_secret_values,
        issuer=settings.jwt_issuer,
        ttl_seconds=settings.access_token_ttl_seconds,
        leeway_seconds=settings.jwt_leeway_seconds,
        clock=clock,
        random=random,
    )
    audit_log = AuditLog(clock)
    authz = AuthorizationService(db)
    auth = AuthService(
        db=db,
        clock=clock,
        random=random,
        hasher=hasher,
        tokens=tokens,
        limiter=limiter,
        policy=AuthPolicy(
            refresh_token_ttl=timedelta(seconds=settings.refresh_token_ttl_seconds),
            session_ttl=timedelta(seconds=settings.session_ttl_seconds),
            login_rule=RateLimitRule(
                "login", settings.login_rate_limit, settings.login_rate_window_seconds
            ),
            refresh_rule=RateLimitRule(
                "refresh", settings.refresh_rate_limit, settings.refresh_rate_window_seconds
            ),
        ),
    )

    async def check_database() -> None:
        await db.ping()

    async def check_redis() -> None:
        await ping(redis)

    return Container(
        settings=settings,
        clock=clock,
        random=random,
        db=db,
        redis=redis,
        mailer=mailer,
        hasher=hasher,
        limiter=limiter,
        tokens=tokens,
        audit_log=audit_log,
        authz=authz,
        auth=auth,
        users=UserService(db=db, clock=clock, hasher=hasher),
        sessions=SessionService(db=db, clock=clock),
        organizations=OrganizationService(db=db, clock=clock, random=random, audit=audit_log),
        roles=RoleService(db=db, clock=clock, authz=authz, audit=audit_log),
        members=MemberService(db=db, clock=clock, authz=authz, audit=audit_log),
        projects=ProjectService(db=db, clock=clock, authz=authz, audit=audit_log),
        invitations=InvitationService(
            db=db,
            clock=clock,
            random=random,
            authz=authz,
            audit=audit_log,
            mailer=mailer,
            policy=InvitationPolicy(
                ttl=timedelta(seconds=settings.invitation_ttl_seconds),
                accept_url_base=settings.public_base_url,
            ),
        ),
        audit=AuditQueryService(db),
        health=HealthService({"database": check_database, "redis": check_redis}),
    )
