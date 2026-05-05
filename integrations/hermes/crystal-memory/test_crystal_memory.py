import importlib.util
import json
import pathlib
import sys
import unittest


PLUGIN_PATH = pathlib.Path(__file__).with_name("__init__.py")
SPEC = importlib.util.spec_from_file_location("crystal_memory_hermes_test", PLUGIN_PATH)
plugin = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = plugin
SPEC.loader.exec_module(plugin)


class FakeClient:
    configured = True
    api_url = "https://convex.example"
    api_key = "mc_test"

    def __init__(self):
        self.calls = []

    def wake(self, session_id, channel):
        self.calls.append(("wake", session_id, channel))
        return {"briefing": "Welcome back. Current project: Hermes integration."}

    def recall(self, query, session_id, channel, limit=6):
        self.calls.append(("recall", query, session_id, channel, limit))
        return {
            "memories": [
                {
                    "title": "Hermes plan",
                    "content": "Use a thin Hermes plugin and MCP for tool parity.",
                    "store": "semantic",
                    "category": "decision",
                }
            ]
        }

    def log(self, role, content, session_id, channel, turn_index=None):
        self.calls.append(("log", role, content, session_id, channel, turn_index))
        return {"ok": True}

    def triggers(self, tool_name):
        self.calls.append(("triggers", tool_name))
        return {"memories": [{"title": "Use preflight before deploy", "content": "Check rollout state."}]}

    def auth(self):
        return {"ok": True}

    def stats(self):
        return {"ok": True, "total": 42}


class HermesPluginTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeClient()
        plugin.SESSIONS.clear()
        plugin.LAST_ERROR = ""
        plugin._CLIENT_FACTORY = lambda: self.client

    def tearDown(self):
        plugin._CLIENT_FACTORY = None

    def test_pre_llm_call_injects_wake_and_recall_context(self):
        result = plugin.pre_llm_call(
            session_id="s1",
            user_message="What did we decide about Hermes?",
            is_first_turn=True,
            platform="cli",
        )

        self.assertIsInstance(result, dict)
        context = result["context"]
        self.assertIn("Active Memory Backend", context)
        self.assertIn("Memory Tool Discipline", context)
        self.assertIn("Hermes plan", context)
        self.assertIn(("wake", "s1", "hermes:cli"), self.client.calls)

    def test_post_llm_call_logs_user_and_assistant_without_capture(self):
        plugin.post_llm_call(
            session_id="s1",
            user_message="remember the plan",
            assistant_response="Done.",
            platform="gateway",
        )

        self.assertEqual(
            [call[0:3] for call in self.client.calls],
            [("log", "user", "remember the plan"), ("log", "assistant", "Done.")],
        )

    def test_status_reports_backend_health(self):
        status = json.loads(plugin.crystal_status())
        self.assertEqual(status["plugin"], "crystal-memory")
        self.assertTrue(status["apiKeyConfigured"])
        self.assertEqual(status["memoryCount"], 42)

    def test_register_wires_expected_hooks(self):
        class Ctx:
            def __init__(self):
                self.hooks = []
                self.commands = []

            def register_hook(self, name, fn):
                self.hooks.append((name, fn.__name__))

            def register_command(self, name, fn, description=None):
                self.commands.append((name, description))

        ctx = Ctx()
        plugin.register(ctx)
        self.assertIn(("pre_llm_call", "pre_llm_call"), ctx.hooks)
        self.assertIn(("post_llm_call", "post_llm_call"), ctx.hooks)
        self.assertEqual(ctx.commands[0][0], "crystal_status")


if __name__ == "__main__":
    unittest.main()
