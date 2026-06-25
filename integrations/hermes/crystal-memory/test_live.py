import importlib.util
import os
import pathlib
import sys
import time
import unittest


PLUGIN_PATH = pathlib.Path(__file__).with_name("__init__.py")
SPEC = importlib.util.spec_from_file_location("crystal_memory_hermes_live", PLUGIN_PATH)
plugin = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = plugin
SPEC.loader.exec_module(plugin)


@unittest.skipUnless(os.environ.get("MEMORY_CRYSTAL_LIVE_TEST") == "1", "set MEMORY_CRYSTAL_LIVE_TEST=1 to run live Hermes smoke tests")
class HermesLiveSmokeTests(unittest.TestCase):
    def setUp(self):
        if not os.environ.get("MEMORY_CRYSTAL_API_KEY"):
            self.skipTest("MEMORY_CRYSTAL_API_KEY is required for live smoke tests")
        suffix = int(time.time() * 1000)
        self.session_id = f"hermes-live-smoke-{suffix}"
        self.channel = f"hermes:live-smoke:{suffix}"
        self.client = plugin.MemoryCrystalClient()

    def test_read_only_backend_smoke(self):
        auth = self.client.auth()
        self.assertTrue(plugin._status_response(auth), auth)

        stats = self.client.stats()
        self.assertIsInstance(stats, dict)

        wake = self.client.wake(self.session_id, self.channel)
        self.assertIsInstance(wake, dict)

        recall = self.client.recall("Memory Crystal Hermes live smoke", self.session_id, self.channel)
        self.assertIsInstance(recall, dict)

        recent = self.client.tool("crystal_recent", {"sessionKey": self.session_id, "channel": self.channel, "limit": 1})
        self.assertIsInstance(recent, dict)

        search = self.client.tool("crystal_search_messages", {"query": "Memory Crystal Hermes live smoke", "sessionKey": self.session_id, "channel": self.channel, "limit": 1})
        self.assertIsInstance(search, dict)

    def test_optional_write_smoke(self):
        if os.environ.get("MEMORY_CRYSTAL_LIVE_WRITE_TEST") != "1":
            self.skipTest("set MEMORY_CRYSTAL_LIVE_WRITE_TEST=1 to run write smoke")

        result = self.client.remember(
            "Hermes live smoke memory",
            "Temporary live smoke memory created by the Hermes plugin test.",
            {
                "store": "semantic",
                "category": "fact",
                "source": "external",
                "channel": self.channel,
                "tags": ["live-smoke", "hermes"],
            },
        )
        self.assertIsInstance(result, dict)
        self.assertFalse(result.get("error"), result)


if __name__ == "__main__":
    unittest.main()
