#!/usr/bin/env python3
"""Remove the sideloaded Eter app from the device."""
import os
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from install import (  # noqa: E402
    APP_ID,
    DEVICE_WEBAPPS,
    PERMISSIONS_DB,
    adb,
    read_registry,
    require_device,
    require_root,
    start_b2g,
    stop_b2g,
    write_registry,
)


def revoke_permissions(local_id):
    """Drop the permission rows install.py added. b2g must be stopped first."""
    origin = "app://%s^appId=%d" % (APP_ID, local_id)
    with tempfile.TemporaryDirectory() as tmp:
        local = os.path.join(tmp, "permissions.sqlite")
        adb("pull", PERMISSIONS_DB, local)

        connection = sqlite3.connect(local)
        try:
            with connection:
                deleted = connection.execute(
                    "DELETE FROM moz_perms WHERE origin = ?", (origin,)
                ).rowcount
        finally:
            connection.close()

        if not deleted:
            print("no permission rows for %s" % origin)
            return

        adb("push", local, PERMISSIONS_DB)
        adb("shell", "chmod 600 %s" % PERMISSIONS_DB)
        print("revoked %d permission row(s) for %s" % (deleted, origin))


def main():
    require_device()
    require_root()

    registry = read_registry()
    entry = registry.get(APP_ID)
    if entry is None:
        print("%s is not registered; nothing to unregister." % APP_ID)
    else:
        remaining = {k: v for k, v in registry.items() if k != APP_ID}
        write_registry(remaining)
        print("unregistered %s" % APP_ID)

    target = "%s/%s" % (DEVICE_WEBAPPS, APP_ID)
    if adb("shell", "ls -d %s 2>/dev/null" % target).strip():
        adb("shell", "rm -rf %s" % target)
        print("removed %s" % target)

    stop_b2g()
    if entry is not None:
        revoke_permissions(entry["localId"])
    start_b2g()
    print("\nDone.")


if __name__ == "__main__":
    sys.exit(main())
