"""Exercise source archive extraction, including the pre-data-filter fallback."""
import contextlib
import importlib.util
import io
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("verify_source", Path(__file__).with_name("verify-source.py"))
verify_source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify_source)


@contextlib.contextmanager
def without_data_filter():
    original = getattr(tarfile, "data_filter", None)
    if original is not None:
        del tarfile.data_filter
    try:
        yield
    finally:
        if original is not None:
            tarfile.data_filter = original


def archive_with(entries):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w") as archive:
        for name, kind in entries:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.mode = 0o4777
            member.linkname = "../../outside.txt"
            payload = b"synthetic source only\n"
            if kind == tarfile.REGTYPE:
                member.size = len(payload)
            archive.addfile(member, io.BytesIO(payload) if member.isfile() else None)
    data.seek(0)
    return tarfile.open(fileobj=data)


class SourceExtractionTests(unittest.TestCase):
    def test_fallback_extracts_nested_bytes_without_archive_permissions(self):
        with tempfile.TemporaryDirectory() as folder, without_data_filter():
            destination = Path(folder) / "extract"
            destination.mkdir()
            with archive_with([("frontend/src/demo.txt", tarfile.REGTYPE)]) as archive:
                verify_source.extract_frontend(archive, destination)
            target = destination / "frontend/src/demo.txt"
            self.assertEqual(target.read_bytes(), b"synthetic source only\n")
            self.assertFalse(target.stat().st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX))

    def test_rejects_posix_and_windows_escape_paths_before_any_write(self):
        names = [
            "/outside.txt", "../outside.txt", "frontend/../../outside.txt",
            r"C:\outside.txt", "C:/outside.txt", r"C:outside.txt",
            r"\outside.txt", r"\\server\share\outside.txt",
            r"frontend\..\..\outside.txt", r"frontend/..\..\outside.txt",
            "frontend/C:/outside.txt", r"frontend/C:\outside.txt",
            "frontend/file.txt:stream", "frontend/../outside.txt",
        ]
        for fallback in [False, True]:
            for name in names:
                with self.subTest(fallback=fallback, name=name), tempfile.TemporaryDirectory() as folder:
                    destination = Path(folder) / "extract"
                    destination.mkdir()
                    context = without_data_filter() if fallback else contextlib.nullcontext()
                    with context, archive_with([("frontend/valid.txt", tarfile.REGTYPE), (name, tarfile.REGTYPE)]) as archive:
                        with self.assertRaises(ValueError):
                            verify_source.extract_frontend(archive, destination)
                    self.assertEqual(list(destination.iterdir()), [])
                    self.assertEqual(list(Path(folder).iterdir()), [destination])

    def test_rejects_links_devices_and_private_paths(self):
        entries = [("frontend/link", tarfile.SYMTYPE), ("frontend/link", tarfile.LNKTYPE),
                   ("frontend/device", tarfile.CHRTYPE), ("frontend/.env", tarfile.REGTYPE),
                   ("frontend/backend/private.txt", tarfile.REGTYPE)]
        for name, kind in entries:
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as folder, without_data_filter():
                destination = Path(folder)
                with archive_with([(name, kind)]) as archive:
                    with self.assertRaises(ValueError):
                        verify_source.extract_frontend(archive, destination)
                self.assertEqual(list(destination.iterdir()), [])

    def test_resolved_target_must_stay_inside_destination(self):
        with tempfile.TemporaryDirectory() as folder, without_data_filter():
            root = Path(folder)
            destination = root / "extract"
            destination.mkdir()
            outside = root / "outside"
            outside.mkdir()
            try:
                (destination / "frontend").symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest("Creating symlinks is not permitted on this host")
            with archive_with([("frontend/escape.txt", tarfile.REGTYPE)]) as archive:
                with self.assertRaisesRegex(ValueError, "escapes destination"):
                    verify_source.extract_frontend(archive, destination)
            self.assertEqual(list(outside.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
