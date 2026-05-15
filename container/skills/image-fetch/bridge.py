"""image-fetch bridge: GET /api/v1/cameras/{id}/snapshot, save jpg, print json.

Backend host is configured via env CAMERA_BASE_URL (default
http://host.docker.internal:8000). When the camera backend lives on a remote
Windows lab machine, set CAMERA_BASE_URL=http://<windows-ip>:<port> in the
worker's container.json env. The hardcoded 192.168.66.x default is preserved
only for backwards-compat with legacy installs where the backend ran on the
camera subnet itself.
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests

BASE = os.environ.get("CAMERA_BASE_URL", "http://host.docker.internal:8000").rstrip("/") + "/api/v1"
VALID_IDS = {"cam0", "cam1", "cam2", "usb0", "usb1"}
# Skill dir is mounted readonly; write to per-session workspace instead.
OUT_DIR = Path(os.environ.get("IMAGE_FETCH_OUTPUT_DIR", "/workspace/agent/image-fetch"))
TIMEOUT = 5

SESSION = requests.Session()
SESSION.trust_env = False


def snapshot(camera_id: str, quality: int = 95) -> dict:
    if camera_id not in VALID_IDS:
        return {
            "ok": False,
            "error": f"invalid camera_id: {camera_id}",
            "valid": sorted(VALID_IDS),
        }
    url = f"{BASE}/cameras/{camera_id}/snapshot"
    params = {"quality": quality, "save": "false"}
    last_err = None
    for attempt in range(2):
        try:
            r = SESSION.get(url, params=params, timeout=TIMEOUT)
            if r.status_code == 200:
                OUT_DIR.mkdir(parents=True, exist_ok=True)
                ts = time.strftime("%Y%m%d_%H%M%S")
                path = OUT_DIR / f"{camera_id}_{ts}.jpg"
                path.write_bytes(r.content)
                return {
                    "ok": True,
                    "path": str(path),
                    "camera_id": camera_id,
                    "bytes": len(r.content),
                }
            last_err = f"HTTP {r.status_code}: {r.text[:200]}"
            if 500 <= r.status_code < 600 and attempt == 0:
                time.sleep(1)
                continue
            return {"ok": False, "error": last_err, "camera_id": camera_id}
        except requests.exceptions.RequestException as e:
            last_err = str(e)
            if attempt == 0:
                time.sleep(1)
                continue
            return {"ok": False, "error": last_err, "camera_id": camera_id}
    return {"ok": False, "error": last_err or "unknown", "camera_id": camera_id}


def list_cameras() -> dict:
    try:
        r = SESSION.get(f"{BASE}/cameras", timeout=TIMEOUT)
        r.raise_for_status()
        return {"ok": True, "data": r.json()}
    except requests.exceptions.RequestException as e:
        return {"ok": False, "error": str(e)}


def main() -> int:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s1 = sub.add_parser("snapshot")
    s1.add_argument("--camera-id", required=True)
    s1.add_argument("--quality", type=int, default=95)
    sub.add_parser("list")
    args = p.parse_args()
    if args.cmd == "snapshot":
        out = snapshot(args.camera_id, args.quality)
    else:
        out = list_cameras()
    print(json.dumps(out, ensure_ascii=False))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
