"""Process entry point: `python -m authz.main` serves the API with uvicorn."""

from __future__ import annotations

import sys

import uvicorn

from authz.app import create_app
from authz.config import ConfigError, load_settings
from authz.container import build_container
from authz.logging import configure_logging


def main() -> int:
    try:
        settings = load_settings()
    except ConfigError as error:
        print(error, file=sys.stderr)
        return 2
    configure_logging(settings.log_level)
    app = create_app(build_container(settings))
    uvicorn.run(
        app,
        host=settings.host,
        port=settings.port,
        log_config=None,
        access_log=False,
        proxy_headers=False,
        server_header=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
