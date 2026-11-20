import unittest

from versions import read_cargo_lock, read_cargo_toml, read_package, write_cargo_lock, write_cargo_toml, write_package

PACKAGE = '{\n  "name": "x",\n  "private": true,\n  "version": "0.1.0",\n  "devDependencies": { "vue": "3.5.45" }\n}\n'
TOML = '[package]\nname = "mediadown-host"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\nserde = { version = "1.0.229" }\n'
LOCK = '[[package]]\nname = "dirs"\nversion = "7.0.0"\n\n[[package]]\nname = "mediadown-host"\nversion = "0.1.0"\ndependencies = [\n "dirs",\n]\n'


class VersionsTest(unittest.TestCase):
    def test_reads_each_file(self):
        self.assertEqual((read_package(PACKAGE), read_cargo_toml(TOML), read_cargo_lock(LOCK)), ("0.1.0",) * 3)

    def test_writes_only_the_project_version(self):
        self.assertEqual(read_package(write_package(PACKAGE, "1.0.0")), "1.0.0")
        self.assertIn('"vue": "3.5.45"', write_package(PACKAGE, "1.0.0"))

        toml = write_cargo_toml(TOML, "1.0.0")
        self.assertEqual(read_cargo_toml(toml), "1.0.0")
        self.assertIn('serde = { version = "1.0.229" }', toml)

        lock = write_cargo_lock(LOCK, "1.0.0")
        self.assertEqual(read_cargo_lock(lock), "1.0.0")
        self.assertIn('name = "dirs"\nversion = "7.0.0"', lock)


if __name__ == "__main__":
    unittest.main()
