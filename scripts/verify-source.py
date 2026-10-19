#!/usr/bin/env python3
"""Rebuild the served frontend source archive and compare every emitted asset."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tempfile

from public_readiness import forbidden_path, scan_bytes


def digest(data):
    return hashlib.sha256(data).hexdigest()


def assets(directory):
    return {path.relative_to(directory).as_posix(): digest(path.read_bytes())
            for path in directory.rglob("*") if path.is_file()}


def main():
    root = Path(__file__).resolve().parents[1]
    current = json.loads((root / "dist/source/current.json").read_text())
    release = current["release"]
    if len(release) != 64 or any(letter not in "0123456789abcdef" for letter in release):
        raise ValueError("Invalid built source release")
    folder = root / "dist/source" / release
    manifest = json.loads((folder / "manifest.json").read_text())
    raw = (folder / "frontend-source.tar.gz").read_bytes()
    if digest(raw) != manifest["frontend"]["sha256"] or len(raw) != manifest["frontend"]["bytes"]:
        raise ValueError("Frontend source archive integrity mismatch")
    with tempfile.TemporaryDirectory(prefix="sayboard-source-check-") as temporary:
        destination = Path(temporary)
        with tarfile.open(folder / "frontend-source.tar.gz") as archive:
            members = archive.getmembers()
            for member in members:
                path = PurePosixPath(member.name)
                relative = PurePosixPath(*path.parts[1:]).as_posix()
                if path.is_absolute() or ".." in path.parts or not member.isfile() or forbidden_path(relative):
                    raise ValueError("Unexpected frontend archive entry: " + member.name)
                if relative.startswith("backend/") or scan_bytes(archive.extractfile(member).read()):
                    raise ValueError("Private content needs review in " + member.name)
            if hasattr(tarfile, "data_filter"):
                archive.extractall(destination, filter="data")
            else:
                # Python without tar extraction filters: every member was checked
                # above as a regular file at a safe relative path, so write only
                # its contents and ignore archive modes and owners.
                for member in members:
                    target = destination.joinpath(*PurePosixPath(member.name).parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(archive.extractfile(member).read())
        packages = list(destination.glob("*/package.json"))
        if len(packages) != 1:
            raise ValueError("Expected one standalone frontend package")
        frontend = packages[0].parent
        for command in [["npm", "ci", "--ignore-scripts"], ["npm", "run", "build"]]:
            result = subprocess.run(command, cwd=frontend, capture_output=True, text=True)
            if result.returncode:
                raise RuntimeError("Standalone source rebuild failed:\n" + (result.stdout + result.stderr)[-4000:])
        expected = assets(root / "dist/assets")
        actual = assets(frontend / "dist/assets")
        if not expected or actual != expected:
            raise ValueError("Standalone browser assets differ from the served build")
    report = {"release": release, "archive_entries_reviewed": len(members), "matching_assets": len(expected), "byte_identical": True}
    output = root / "test-results/publication/source-rebuild.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
