"""Deterministic offline test profile; never load personal .env credentials."""
import os
os.environ["OWAUA_ENV_FILE"] = os.devnull
os.environ["OWAUA_LOCAL_ONLY"] = "0"
os.environ["OPENAI_API_KEY"] = "offline-test-key"
os.environ["INCEPTION_API_KEY"] = "offline-test-key"
os.environ["DISCORD_TOKEN"] = ""
