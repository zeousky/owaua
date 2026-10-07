"""Deployment checks without provider calls or Discord messages."""

import io
import json
import os
from pathlib import Path
import shutil
import sys
import wave
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "owaua"))

from memory import MemoryStore
from music import BoundedAudio, _ACTIVE_SOURCES, play_track
from security import ALLOW_DMS, API_LIMITS, MAX_INFLIGHT

if not sys.platform.startswith("linux"):
    raise RuntimeError("Production music requires Linux resource limits")
if os.geteuid() == 0:
    raise RuntimeError("Run the production bot as an unprivileged user")
if not shutil.which("ffmpeg"):
    raise RuntimeError("FFmpeg is missing")
if not shutil.which("deno"):
    raise RuntimeError("Deno is missing; YouTube links cannot be resolved")

output = io.BytesIO()
with wave.open(output, "wb") as wav:
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(48000)
    wav.writeframes(b"\0\0" * 4800)
source = BoundedAudio(output.getvalue())
decoder_process = source._process
try:
    if not source.read():
        raise RuntimeError("Restricted FFmpeg decoder produced no audio")
finally:
    source.cleanup()
if source in _ACTIVE_SOURCES or decoder_process.poll() is None:
    raise RuntimeError("Restricted decoder cleanup failed")


class DisconnectedVoice:
    def play(self, source, *, after):
        raise RuntimeError("disconnected")


try:
    play_track(DisconnectedVoice(), {"audio_bytes": output.getvalue()})
except RuntimeError as error:
    if str(error) != "disconnected":
        raise
else:
    raise RuntimeError("Disconnected voice was accepted")
if _ACTIVE_SOURCES:
    raise RuntimeError("Failed playback leaked a decoder")

root = Path(__file__).resolve().parents[1]
store = MemoryStore(root / "data" / "memory.sqlite3")
try:
    schema_version = store._connect().execute("PRAGMA user_version").fetchone()[0]
finally:
    store.close()
verification = {
    "timestamp": time.time(),
    "schema_version": schema_version,
    "python": sys.version.split()[0],
    "unprivileged": True,
    "native_decoder": "passed",
    "deno": "available",
    "allow_dms": ALLOW_DMS,
    "max_inflight": MAX_INFLIGHT,
    "api_limits": vars(API_LIMITS),
}
(root / "data" / "runtime-check.json").write_text(
    json.dumps(verification), encoding="utf-8"
)
os.chmod(root / "data" / "runtime-check.json", 0o600)
print("OWAUA_RUNTIME_VERIFIED " + json.dumps(verification), flush=True)
