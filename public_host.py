"""Production entrypoint for the owner-independent Social public host."""

import os
from pathlib import Path

from public_host_factory import _baked_source_sha, create_app

app = create_app(
  Path(os.environ.get("SOCIAL_DATA_DIR", "/data")),
  source_sha=_baked_source_sha(),
)
