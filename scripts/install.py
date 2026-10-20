#!/usr/bin/env python3
"""Sideload Eter onto a rooted KaiOS 2.5 device over adb.

KaiOS has no `adb install`. A packaged app is installed by placing
`application.zip` + `manifest.webapp` under /data/local/webapps/<app-id>/ and
registering an entry in /data/local/webapps/webapps.json, then restarting b2g.

The app id and app type (privileged/certified) come from manifest.webapp.
"""
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time

DEVICE_WEBAPPS = "/data/local/webapps"
REGISTRY = DEVICE_WEBAPPS + "/webapps.json"
PERMISSIONS_DB = "/data/local/permissions.sqlite"
APP_STATUS = {"web": 1, "privileged": 2, "certified": 3}
PERMISSION_ALLOW = 1

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ZIP_PATH = os.path.join(ROOT, "dist", "application.zip")
MANIFEST_PATH = os.path.join(ROOT, "app", "manifest.webapp")

with open(MANIFEST_PATH, "r", encoding="utf-8") as _fh:
    _MANIFEST = json.load(_fh)
APP_ID = _MANIFEST["origin"].replace("app://", "")
APP_NAME = _MANIFEST["name"]
APP_STATUS_CODE = APP_STATUS[_MANIFEST.get("type", "web")]


def adb(*args, check=True, binary=False):
    result = subprocess.run(
        ["adb"] + list(args),
        capture_output=True,
        check=False,
    )
    if check and result.returncode != 0:
        raise SystemExit(
            "adb %s failed:\n%s" % (" ".join(args), result.stderr.decode("utf-8", "replace"))
        )
    return result.stdout if binary else result.stdout.decode("utf-8", "replace")


def require_device():
    lines = [l for l in adb("devices").splitlines()[1:] if l.strip()]
    devices = [l.split()[0] for l in lines if l.split()[1:2] == ["device"]]
    if not devices:
        raise SystemExit("No adb device in 'device' state. Is the phone plugged in and unlocked?")
    if len(devices) > 1:
        raise SystemExit("Multiple devices attached; set ANDROID_SERIAL: %s" % ", ".join(devices))
    print("device: %s" % devices[0])


def require_root():
    who = adb("shell", "id").strip()
    if "uid=0" not in who:
        raise SystemExit("adb shell is not root (%s). Run: adb root" % who)


def require_build():
    for path in (ZIP_PATH, MANIFEST_PATH):
        if not os.path.exists(path):
            raise SystemExit("Missing %s - run scripts/build.sh first." % path)


def read_registry():
    """Pull webapps.json to a temp file so binary-safe transfer is guaranteed."""
    with tempfile.TemporaryDirectory() as tmp:
        local = os.path.join(tmp, "webapps.json")
        adb("pull", REGISTRY, local)
        with open(local, "r", encoding="utf-8") as fh:
            return json.load(fh)


def write_registry(registry):
    with tempfile.TemporaryDirectory() as tmp:
        local = os.path.join(tmp, "webapps.json")
        with open(local, "w", encoding="utf-8") as fh:
            json.dump(registry, fh, indent=2, ensure_ascii=False)
        backup = "%s.bak-%d" % (REGISTRY, int(time.time()))
        adb("shell", "cp %s %s" % (REGISTRY, backup))
        print("registry backup: %s" % backup)
        adb("push", local, REGISTRY)
        adb("shell", "chmod 600 %s" % REGISTRY)


def next_local_id(registry):
    used = {entry.get("localId", 0) for entry in registry.values()}
    candidate = 1001
    while candidate in used:
        candidate += 1
    return candidate


def manifest_hash(path):
    """Gecko stores an MD5 of the manifest text; used only for update checks."""
    with open(path, "rb") as fh:
        return hashlib.md5(fh.read()).hexdigest()


def build_entry(local_id, now_ms):
    return {
        "version": 1,
        "name": APP_NAME,
        "id": APP_ID,
        "localId": local_id,
        "basePath": DEVICE_WEBAPPS,
        "origin": "app://" + APP_ID,
        "installOrigin": "app://" + APP_ID,
        "manifestURL": "app://%s/manifest.webapp" % APP_ID,
        "appStatus": APP_STATUS_CODE,
        "kind": "packaged",
        "role": "",
        "csp": "",
        "installTime": now_ms,
        "updateTime": now_ms,
        "lastUpdateCheck": now_ms,
        "manifestHash": manifest_hash(MANIFEST_PATH),
        "installState": "installed",
        "installerAppId": 0,
        "installerIsBrowser": False,
        "removable": True,
        "enabled": True,
        "blockedStatus": 0,
        "progress": 0,
        "downloadAvailable": False,
        "downloading": False,
        "readyToApplyDownload": False,
        "downloadSize": 0,
        "storeId": "",
        "storeVersion": 0,
        "userAgentInfo": "",
        "redirects": None,
        "widgetPages": [],
        "additionalLanguages": {},
    }


def push_app_files():
    target = "%s/%s" % (DEVICE_WEBAPPS, APP_ID)
    adb("shell", "mkdir -p %s" % target)
    adb("push", ZIP_PATH, "%s/application.zip" % target)
    adb("push", MANIFEST_PATH, "%s/manifest.webapp" % target)
    adb("shell", "chmod 700 %s" % target)
    adb("shell", "chmod 600 %s/application.zip %s/manifest.webapp" % (target, target))
    print("pushed app files to %s" % target)


def stop_b2g():
    print("stopping b2g (the phone UI will go dark) ...")
    adb("shell", "stop b2g")
    time.sleep(3)


def start_b2g():
    print("starting b2g (the phone UI will reload, ~20-30s) ...")
    adb("shell", "start b2g")


def restart_b2g():
    stop_b2g()
    start_b2g()


def declared_permissions():
    """Permission names from the manifest.

    Gecko's PermissionsInstaller normally writes these rows at install time;
    a hand-registered app skips that, so we write them ourselves. Only plain
    permission names are handled - anything using an "access" level expands
    into several rows (settings -> settings-read/-write/...) and is rejected
    here rather than silently half-granted.
    """
    with open(MANIFEST_PATH, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)

    names = []
    for name, spec in (manifest.get("permissions") or {}).items():
        if isinstance(spec, dict) and "access" in spec:
            raise SystemExit(
                "Permission %r uses an access level; install.py only handles "
                "plain permissions." % name
            )
        names.append(name)
    return names


def grant_permissions(local_id):
    """Insert ALLOW rows into permissions.sqlite. b2g must be stopped first."""
    names = declared_permissions()
    if not names:
        print("no permissions declared; skipping permission grant")
        return

    origin = "app://%s^appId=%d" % (APP_ID, local_id)
    now_ms = int(time.time() * 1000)

    with tempfile.TemporaryDirectory() as tmp:
        local = os.path.join(tmp, "permissions.sqlite")
        adb("pull", PERMISSIONS_DB, local)

        connection = sqlite3.connect(local)
        try:
            with connection:
                connection.execute("DELETE FROM moz_perms WHERE origin = ?", (origin,))
                connection.executemany(
                    "INSERT INTO moz_perms "
                    "(origin, type, permission, expireType, expireTime, modificationTime) "
                    "VALUES (?, ?, ?, 0, 0, ?)",
                    [(origin, name, PERMISSION_ALLOW, now_ms) for name in names],
                )
        finally:
            connection.close()

        backup = "%s.bak-%d" % (PERMISSIONS_DB, int(time.time()))
        adb("shell", "cp %s %s" % (PERMISSIONS_DB, backup))
        print("permissions backup: %s" % backup)
        adb("push", local, PERMISSIONS_DB)
        adb("shell", "chmod 600 %s" % PERMISSIONS_DB)

    print("granted for %s: %s" % (origin, ", ".join(names)))


def main():
    require_device()
    require_root()
    require_build()

    registry = read_registry()
    existing = registry.get(APP_ID)
    local_id = existing["localId"] if existing else next_local_id(registry)
    print("%s app id %s (localId %d)" % ("updating" if existing else "installing", APP_ID, local_id))

    push_app_files()

    now_ms = int(time.time() * 1000)
    entry = build_entry(local_id, now_ms)
    if existing:
        entry["installTime"] = existing.get("installTime", now_ms)

    # Replace, don't mutate, the registry we read.
    updated = dict(registry)
    updated[APP_ID] = entry
    write_registry(updated)

    # The permission DB is owned by a running b2g, so edit it while b2g is down.
    stop_b2g()
    grant_permissions(local_id)
    start_b2g()
    print("\nDone. Look for '%s' in the phone's app list." % APP_NAME)


if __name__ == "__main__":
    sys.exit(main())
