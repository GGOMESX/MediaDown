import json
import unittest

from bump_ytdlp import bump_ci, bump_engines, current_version, validate

ENGINES = json.dumps({
    "ytDlp": {"version": "2026.10.26", "url": "old", "sha256": "a" * 64},
    "ffmpeg": {"version": "8.1.1", "files": {"bin/ffmpeg.exe": "b" * 64}},
})
CI = "env:\n  YT_DLP_VERSION: '2026.10.26'\njobs: {}\n"


class BumpTest(unittest.TestCase):
    def test_updates_only_yt_dlp(self):
        result = json.loads(bump_engines(ENGINES, "2026.12.01", "c" * 64))
        self.assertEqual(result["ytDlp"], {
            "version": "2026.12.01",
            "url": "https://github.com/yt-dlp/yt-dlp/releases/download/2026.12.01/yt-dlp.exe",
            "sha256": "c" * 64,
        })
        self.assertEqual(result["ffmpeg"]["version"], "8.1.1")

    def test_updates_ci_version(self):
        self.assertIn("YT_DLP_VERSION: '2026.12.01'", bump_ci(CI, "2026.12.01"))

    def test_refuses_ci_without_marker(self):
        with self.assertRaises(ValueError):
            bump_ci("jobs: {}\n", "2026.12.01")

    def test_reads_current_version(self):
        self.assertEqual(current_version(ENGINES), "2026.10.26")

    def test_validates_inputs(self):
        validate("2026.12.01", "d" * 64)
        validate("2026.12.01.1", "d" * 64)
        for version, sha in [("latest", "d" * 64), ("2026.12.01; rm -rf /", "d" * 64), ("2026.12.01", "xyz")]:
            with self.assertRaises(ValueError):
                validate(version, sha)


if __name__ == "__main__":
    unittest.main()
