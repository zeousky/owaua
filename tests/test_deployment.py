"""Offline tests of deployment startup verification and runtime recovery."""

import offline_test_config
import hashlib
import io
import json
import tempfile
import time as real_time
import unittest
import urllib.parse
from contextlib import redirect_stdout
from pathlib import Path


class Clock:
    def __init__(self):
        self.now = 1000
        self.elapsed = 0

    def time(self):
        return self.now

    def monotonic(self):
        return self.elapsed

    def sleep(self, seconds):
        self.now += seconds
        self.elapsed += seconds

    gmtime = staticmethod(real_time.gmtime)
    strftime = staticmethod(real_time.strftime)


class Client:
    def __init__(self, clock, release, *, healthy=True, fail_upload=False):
        self.clock = clock
        self.release = release
        self.healthy = healthy
        self.fail_upload = fail_upload
        self.files = {
            "src/owaua/ask.py": b"previous runtime",
            ".env": b"private previous environment",
            "data/memory.sqlite3": b"persistent database",
        }
        self.current_state = "running"
        self.restarts = 0
        self.variables = {
            "STARTUP_CMD": "previous main",
            "SECOND_CMD": "previous second",
        }

    def server_path(self, suffix):
        return suffix

    def state(self):
        return self.current_state

    def restart(self):
        self.restarts += 1
        self.current_state = "running"

    def update_startup_variable(self, key, value):
        self.variables[key] = value

    def write_file(self, path, contents):
        if self.fail_upload:
            self.fail_upload = False
            raise RuntimeError("simulated upload failure")
        self.files[path.removeprefix("persona-test-bot/")] = contents

    def request(self, method, path, data=None, expect_json=True):
        if path == "/power":
            self.current_state = "offline"
            return {}
        if path == "/startup":
            return {
                "data": [
                    {"attributes": {"env_variable": k, "server_value": v}}
                    for k, v in self.variables.items()
                ]
            }
        if path == "/files/delete":
            for name in data["files"]:
                self.files.pop(name, None)
            return {}
        relative = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)["file"][
            0
        ].removeprefix("/persona-test-bot/")
        if self.restarts and relative == "data/readiness.json" and self.healthy:
            return json.dumps(
                {
                    "timestamp": self.clock.time() + 1,
                    "release": self.release,
                    "bot_id": 99,
                    "logged_in_as": "Owaua",
                }
            ).encode()
        if self.restarts and relative == "data/runtime-check.json" and self.healthy:
            return json.dumps(
                {
                    "timestamp": self.clock.time() + 1,
                    "native_decoder": "passed",
                    "schema_version": 1,
                }
            ).encode()
        if relative not in self.files:
            error = RuntimeError("not found")
            error.status = 404
            raise error
        return self.files[relative]


class DeploymentTests(unittest.TestCase):
    def prepare(self, **options):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        for name in ("ask.py", "bot.py", "memory.py", "intelligence.py"):
            path = root / "src" / "owaua" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"new runtime")
        release = hashlib.sha256(b"new runtime" * 4).hexdigest()
        clock = Clock()
        client = Client(clock, release, **options)
        script = (
            Path(__file__)
            .resolve()
            .parents[1]
            .joinpath("scripts/deploy.sh")
            .read_text()
        )
        source = script[script.index("def read_remote(relative):") :].rsplit("\nPY", 1)[
            0
        ]
        namespace = {
            "root": root,
            "client": client,
            "uploads": [(root / "src" / "owaua" / name, f"src/owaua/{name}") for name in ("ask.py", "bot.py", "memory.py", "intelligence.py")],
            "env_payload": b"new environment",
            "time": clock,
            "json": json,
            "hashlib": hashlib,
            "urllib": __import__("urllib"),
        }
        return source, namespace, client

    def test_success_requires_fresh_runtime_and_matching_login(self):
        source, namespace, client = self.prepare()
        with redirect_stdout(io.StringIO()) as output:
            exec(compile(source, "deployment", "exec"), namespace)
        self.assertIn("OWAUA_DEPLOYMENT_HEALTHY", output.getvalue())
        self.assertEqual(client.files["data/memory.sqlite3"], b"persistent database")
        self.assertEqual(client.restarts, 1)

    def test_local_edit_during_network_io_does_not_change_uploaded_release(self):
        source, namespace, client = self.prepare()
        original = client.request
        def edit_during_request(*args, **kwargs):
            (namespace["root"] / "src/owaua/ask.py").write_bytes(b"later local edit")
            return original(*args, **kwargs)
        client.request = edit_during_request
        with redirect_stdout(io.StringIO()) as output:
            exec(compile(source, "deployment", "exec"), namespace)
        self.assertIn("OWAUA_DEPLOYMENT_HEALTHY", output.getvalue())
        self.assertEqual(client.files["src/owaua/ask.py"], b"new runtime")

    def test_failed_upload_restores_runtime_environment_and_startup(self):
        source, namespace, client = self.prepare(fail_upload=True)
        with (
            redirect_stdout(io.StringIO()),
            self.assertRaisesRegex(RuntimeError, "upload failure"),
        ):
            exec(compile(source, "deployment", "exec"), namespace)
        self.assertEqual(client.files["src/owaua/ask.py"], b"previous runtime")
        self.assertEqual(client.files[".env"], b"private previous environment")
        self.assertEqual(client.variables["SECOND_CMD"], "previous second")
        self.assertEqual(client.files["data/memory.sqlite3"], b"persistent database")
        self.assertEqual(client.restarts, 1)

    def test_missing_readiness_restores_previous_runtime(self):
        source, namespace, client = self.prepare(healthy=False)
        with (
            redirect_stdout(io.StringIO()),
            self.assertRaisesRegex(RuntimeError, "Discord login"),
        ):
            exec(compile(source, "deployment", "exec"), namespace)
        self.assertEqual(client.files["src/owaua/ask.py"], b"previous runtime")
        self.assertEqual(client.restarts, 2)
