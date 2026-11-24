"""Drop-in compatibility layers that run other social-posting SDKs' code on Hermoso (https://hermoso.ai).

    from hermoso_compat.ayrshare import SocialPost   # Ayrshare's social-post-api
    from hermoso_compat.zernio import Zernio         # Zernio's zernio-sdk

Unofficial: written by Hermoso. Not affiliated with, endorsed by or sponsored by Ayrshare or Zernio; their names are
used only to say which SDK each layer is compatible with.
"""

from ._core import VERSION, HermosoApiError, HermosoClient, HermosoUnsupportedError

__version__ = VERSION
__all__ = ["HermosoClient", "HermosoApiError", "HermosoUnsupportedError", "__version__"]
