from __future__ import annotations

import threading


# Cache generation and cache removal share this lock.  It prevents a cleanup
# request from deleting a directory while a preview, tile, or composite mask is
# being generated.
CACHE_MAINTENANCE_LOCK = threading.RLock()
