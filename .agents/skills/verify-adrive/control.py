#!/usr/bin/env python3
"""Disposable local tdrive runtime; proof artifacts outlive cleanup."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[3]
ORIGIN = "http://localhost:5173"
# Public fixture credential, used only in the disposable local runtime.
PASSCODE = "adrive-verification-local-only"


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def state(run):
    return json.loads((run / "instance.json").read_text())


def request(path, method="GET", body=None, headers=None, origin=ORIGIN):
    req = urllib.request.Request(origin + path, data=body, method=method,
                                 headers=headers or {})
    try:
        response = urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, response.headers, response.read()


def api(run, path):
    config = json.loads((run / "runtime/.verify-config/tdrive/config.json").read_text())
    return request(path, headers={"Authorization": "Bearer " + config["apiKey"]})


def process_identity(pid):
    try:
        # Linux start ticks distinguish an owned process from a reused PID.
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return fields[19]
    except FileNotFoundError:
        return None


def check_owner(info):
    if process_identity(info["pid"]) != info["start_ticks"]:
        raise RuntimeError("Recorded dev process is absent or PID has been reused")
    for port in (5173, 5174):
        listeners = subprocess.check_output(
            ["ss", "-H", "-ltnp", f"sport = :{port}"], text=True)
        pids = [int(pid) for pid in re.findall(r"pid=(\d+)", listeners)]
        if not pids or any(os.getpgid(pid) != info["pid"] for pid in pids):
            raise RuntimeError(f"Port {port} is not owned by this run")


def doctor(run):
    info = state(run)
    check_owner(info)
    status, _, body = api(run, "/api/files")
    if status != 200:
        raise RuntimeError(f"Authenticated listing returned {status}")
    listing = json.loads(body)
    assert listing["contentOrigin"] == "http://localhost:5174"
    assert listing["semantic"]["enabled"] is False
    assert request("/api/files")[0] == 401
    assert request("/api/files", origin="http://localhost:5174")[0] == 421
    result = {"status": "PASS", "source_sha": info["source_sha"],
              "source_note": "Copy includes current tracked and unignored source changes",
              "runtime": str(run / "runtime"), "ports_owned": [5173, 5174],
              "authenticated_listing": status, "unauthenticated_listing": 401,
              "content_origin_api": 421, "files": len(listing["files"])}
    write_json(run / "evidence/doctor.json", result)
    print(json.dumps(result))


def launch(run):
    if (run / "runtime").exists():
        raise RuntimeError("Runtime already exists; cleanup and use a new run")
    for port in (5173, 5174):
        with socket.socket() as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(("0.0.0.0", port))
    runtime = run / "runtime"
    runtime.mkdir(mode=0o700)
    try:
        # Copy source, never the checkout's ignored credentials or local storage.
        names = subprocess.check_output(
            ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            cwd=ROOT).decode().split("\0")
        source_files = {}
        for name in names:
            if not name or not (name.startswith(("apps/", "packages/", "scripts/"))
                                    or "/" not in name):
                continue
            src = ROOT / name
            if src.is_symlink():
                raise RuntimeError(f"Refusing source symlink: {name}")
            if src.is_file():
                dst = runtime / name
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
                source_files[name] = hashlib.sha256(dst.read_bytes()).hexdigest()
        write_json(run / "evidence/source-files.json", source_files)
        (runtime / "apps/web/.dev.vars").write_text(
            f'PASSCODE="{PASSCODE}"\nDASHBOARD_ORIGIN="{ORIGIN}"\n'
            'CONTENT_ORIGIN="http://localhost:5174"\nSEMANTIC_SEARCH="off"\n')
        with (run / "evidence/setup.log").open("w") as log:
            for command in (["bun", "install", "--frozen-lockfile"],
                            ["bun", "db:migrate:local"]):
                log.write("$ " + " ".join(command) + "\n")
                log.flush()
                subprocess.run(command, cwd=runtime, stdout=log, stderr=log, check=True)
        with (run / "evidence/server.log").open("w") as log:
            process = subprocess.Popen(["bun", "--filter", "@tdrive/web", "dev"],
                                       cwd=runtime, stdout=log, stderr=log,
                                       start_new_session=True)
        info = {"pid": process.pid, "start_ticks": process_identity(process.pid),
                "source_sha": subprocess.check_output(
                    ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()}
        write_json(run / "instance.json", info)
        deadline = time.monotonic() + 120
        while True:
            if process.poll() is not None:
                raise RuntimeError("Dev process exited; inspect evidence/server.log")
            try:
                if request("/api/files")[0] == 401:
                    break
            except (OSError, urllib.error.URLError):
                pass
            if time.monotonic() > deadline:
                raise RuntimeError("Dashboard did not become ready in 120 seconds")
            time.sleep(0.5)
        # Fixture setup uses production auth endpoints, not SQL credential inserts.
        status, headers, _ = request("/api/auth/session", "POST",
            json.dumps({"passcode": PASSCODE}).encode(),
            {"Origin": ORIGIN, "Content-Type": "application/json"})
        assert status == 200, f"Fixture login failed: {status}"
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        status, _, body = request("/api/auth/keys", "POST",
            json.dumps({"name": "verification-fixture", "scope": "read-write"}).encode(),
            {"Origin": ORIGIN, "Content-Type": "application/json", "Cookie": cookie})
        assert status == 201, f"Fixture key creation failed: {status}"
        config_dir = runtime / ".verify-config/tdrive"
        config_dir.mkdir(parents=True, mode=0o700)
        config = config_dir / "config.json"
        write_json(config, {"endpoint": ORIGIN, "contentOrigin": "http://localhost:5174",
                            "apiKey": json.loads(body)["token"]})
        config.chmod(0o600)
        request("/api/auth/session", "DELETE", headers={"Origin": ORIGIN, "Cookie": cookie})
        doctor(run)
    except BaseException:
        cleanup(run)
        raise


def cleanup(run):
    instance = run / "instance.json"
    if instance.exists():
        info = state(run)
        if process_identity(info["pid"]) == info["start_ticks"]:
            os.killpg(info["pid"], signal.SIGTERM)
            for _ in range(50):
                try:
                    os.killpg(info["pid"], 0)
                except ProcessLookupError:
                    break
                time.sleep(0.1)
            else:
                os.killpg(info["pid"], signal.SIGKILL)
        else:
            # An exited leader can leave group members. Refuse to guess ownership.
            try:
                os.killpg(info["pid"], 0)
            except ProcessLookupError:
                pass
            else:
                raise RuntimeError("Leader identity changed; inspect recorded process group before cleanup")
    shutil.rmtree(run / "runtime", ignore_errors=True)
    write_json(run / "evidence/cleanup.json", {"runtime_removed": not (run / "runtime").exists(),
                                             "evidence_retained": True})
    print(f"Cleaned runtime; evidence retained at {run / 'evidence'}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["new", "launch", "doctor", "cli", "http", "cleanup"])
    parser.add_argument("run", nargs="?", type=Path)
    parser.add_argument("args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command == "new":
        run = Path.home() / ".local/state/adrive-verification" / str(uuid.uuid4())
        (run / "evidence/inputs/site").mkdir(parents=True, mode=0o700)
        run.chmod(0o700)
        (run / "evidence/inputs/verify-note.txt").write_text("Verification orchid budget first version.\n")
        (run / "evidence/inputs/replacement.txt").write_text("Verification orchid budget second version.\n")
        (run / "evidence/inputs/site/index.html").write_text("<!doctype html><h1>Verification orchid site</h1>\n")
        print(run)
        return
    if args.run is None:
        parser.error("run path from `control.py new` is required")
    run = args.run.resolve()
    if run.parent != Path.home() / ".local/state/adrive-verification":
        parser.error("run must be created by `control.py new`")
    if args.command in ("launch", "doctor", "cleanup"):
        globals()[args.command](run)
    elif args.command == "cli":
        check_owner(state(run))
        command = args.args[1:] if args.args[:1] == ["--"] else args.args
        env = {**os.environ, "XDG_CONFIG_HOME": str(run / "runtime/.verify-config")}
        sys.exit(subprocess.run(
            ["node", "--experimental-strip-types", "src/main.ts", *command],
            cwd=run / "runtime/packages/cli", env=env).returncode)
    else:
        doctor(run)
        if len(args.args) != 2 or not args.args[0].startswith("/api/"):
            parser.error("http requires a read-only /api/path and an evidence basename")
        path, name = args.args
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", name):
            parser.error("evidence basename must be letters, digits, underscores, or hyphens")
        status, _, body = api(run, path)
        (run / f"evidence/{name}.json").write_bytes(body)
        print(json.dumps({"method": "GET", "path": path, "status": status,
                          "sha256": hashlib.sha256(body).hexdigest()}))
        if status != 200:
            sys.exit(1)


if __name__ == "__main__":
    main()
