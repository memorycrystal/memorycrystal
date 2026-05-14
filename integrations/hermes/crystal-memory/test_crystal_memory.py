import importlib.util
import json
import os
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

    def turn(self, session_id, channel, user_message, assistant_message, **kwargs):
        self.calls.append(("turn", session_id, channel, user_message, assistant_message, kwargs))
        return {"ok": True, "messages": [{"role": "user", "id": "u1"}, {"role": "assistant", "id": "a1"}]}

    def triggers(self, tool_name):
        self.calls.append(("triggers", tool_name))
        return {"memories": [{"title": "Use preflight before deploy", "content": "Check rollout state."}]}

    def auth(self):
        return {"ok": True}

    def stats(self):
        return {"ok": True, "total": 42}

    def remember(self, title, content, metadata=None):
        self.calls.append(("remember", title, content, metadata))
        return {"ok": True, "id": "m1"}

    def checkpoint(self, session_id, channel, label, summary, metadata=None):
        self.calls.append(("checkpoint", session_id, channel, label, summary, metadata))
        return {"ok": True, "id": "c1"}

    def tool(self, tool_name, args):
        self.calls.append(("tool", tool_name, args))
        return {"ok": True, "tool": tool_name, "args": args}


class HermesPluginTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeClient()
        plugin.SESSIONS.clear()
        plugin.LAST_ERROR = ""
        plugin.ACTIVE_MODE = "unregistered"
        plugin.ACTIVE_MODE_REASON = ""
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
        local_user = os.environ.get("USER") or "local"
        self.assertIn(("wake", "s1", f"cli:{local_user}:{local_user}"), self.client.calls)

    def test_post_llm_call_captures_turn_once(self):
        plugin.post_llm_call(
            session_id="s1",
            user_message="remember the plan",
            assistant_response="Done.",
            platform="gateway",
            user_id="gerald",
            agent_workspace="/tmp/memorycrystal",
        )

        self.assertEqual(self.client.calls[0][0], "turn")
        self.assertEqual(self.client.calls[0][1:5], ("s1", "hermes:gateway:gerald:memorycrystal", "remember the plan", "Done."))
        self.assertTrue(self.client.calls[0][5]["turn_id"].startswith("s1:"))
        self.assertEqual(plugin.SESSIONS["s1"].last_capture_mode, "turn")

    def test_post_llm_call_prefers_hermes_lifecycle_turn_id(self):
        plugin.post_llm_call(
            session_id="s1",
            user_message="remember the plan",
            assistant_response="Done.",
            platform="gateway",
            turn_id="hermes-turn-123",
        )

        self.assertEqual(self.client.calls[0][5]["turn_id"], "hermes-turn-123")

    def test_post_llm_call_derives_stable_turn_id_for_same_content_retry(self):
        plugin.post_llm_call(
            session_id="s1",
            user_message="remember the plan",
            assistant_response="Done.",
            platform="gateway",
        )
        first_turn_id = self.client.calls[-1][5]["turn_id"]

        plugin.post_llm_call(
            session_id="s1",
            user_message="remember the plan",
            assistant_response="Done.",
            platform="gateway",
        )
        second_turn_id = self.client.calls[-1][5]["turn_id"]

        self.assertEqual(second_turn_id, first_turn_id)

    def test_post_llm_call_falls_back_to_log_when_turn_unavailable(self):
        def unavailable_turn(*args, **kwargs):
            self.client.calls.append(("turn",) + args)
            return {"status": 404, "error": "Not Found"}

        self.client.turn = unavailable_turn
        plugin.post_llm_call(
            session_id="s1",
            user_message="remember the plan",
            assistant_response="Done.",
            platform="gateway",
        )

        self.assertEqual(
            [call[0:3] for call in self.client.calls],
            [("turn", "s1", f"hermes:gateway:local:{os.environ.get('USER') or 'local'}"), ("log", "user", "remember the plan"), ("log", "assistant", "Done.")],
        )
        self.assertEqual(plugin.SESSIONS["s1"].last_capture_mode, "log-fallback")

    def test_post_llm_call_skips_group_writes_by_default(self):
        plugin.post_llm_call(
            session_id="s1",
            user_message="remember this",
            assistant_response="Done.",
            platform="discord",
            user_id="u1",
            channel_type="group",
        )

        self.assertEqual(self.client.calls, [])
        self.assertEqual(plugin.SESSIONS["s1"].last_capture_mode, "skipped")

    def test_status_reports_backend_health(self):
        plugin.ACTIVE_MODE = "hooks"
        plugin.ACTIVE_MODE_REASON = "registered lifecycle hooks"
        status = json.loads(plugin.crystal_status())
        self.assertEqual(status["plugin"], "crystal-memory")
        self.assertEqual(status["activeMode"], "hooks")
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
        self.assertEqual(plugin.ACTIVE_MODE, "hooks")

    def test_register_prefers_provider_when_available(self):
        class Ctx:
            def __init__(self):
                self.providers = []
                self.hooks = []
                self.commands = []

            def register_memory_provider(self, provider):
                self.providers.append(provider)

            def register_hook(self, name, fn):
                self.hooks.append((name, fn.__name__))

            def register_command(self, name, fn, description=None):
                self.commands.append((name, description))

        ctx = Ctx()
        plugin.register(ctx)

        self.assertEqual(len(ctx.providers), 1)
        self.assertIsInstance(ctx.providers[0], plugin.MemoryCrystalProvider)
        self.assertEqual(ctx.hooks, [])
        self.assertEqual(plugin.ACTIVE_MODE, "provider")

    def test_register_provider_mode_degrades_without_provider_surface(self):
        os.environ["MEMORY_CRYSTAL_HERMES_MODE"] = "provider"
        try:
            class Ctx:
                def __init__(self):
                    self.commands = []

                def register_command(self, name, fn, description=None):
                    self.commands.append((name, description))

            ctx = Ctx()
            plugin.register(ctx)

            self.assertEqual(plugin.ACTIVE_MODE, "degraded")
            self.assertIn("neither register_memory_provider", plugin.ACTIVE_MODE_REASON)
            self.assertEqual(ctx.commands[0][0], "crystal_status")
        finally:
            os.environ.pop("MEMORY_CRYSTAL_HERMES_MODE", None)

    def test_provider_prefetch_and_sync_turn(self):
        provider = plugin.MemoryCrystalProvider()
        provider.initialize("s1", platform="cli", user_id="gerald", agent_workspace="/tmp/memorycrystal")

        context = provider.prefetch("What did we decide?")
        provider.sync_turn("Remember this", "Saved.")

        self.assertIn("Hermes plan", context)
        self.assertEqual(self.client.calls[0][0], "wake")
        self.assertEqual(self.client.calls[-1][0], "turn")
        self.assertEqual(plugin.SESSIONS["s1"].hooks["provider.prefetch"], 1)
        self.assertEqual(plugin.SESSIONS["s1"].hooks["provider.sync_turn"], 1)

    def test_provider_tool_bridge_returns_json_string(self):
        provider = plugin.MemoryCrystalProvider()
        result = json.loads(provider.handle_tool_call("crystal_stats", {}))

        self.assertTrue(result["success"])
        self.assertEqual(result["result"]["tool"], "crystal_stats")

    def test_provider_memory_write_maps_user_target(self):
        provider = plugin.MemoryCrystalProvider()
        provider.initialize("s1", platform="cli")
        provider.on_memory_write("add", "user", "Gerald prefers concise plans.", {"source": "unit"})

        self.assertEqual(self.client.calls[-1][0], "remember")
        self.assertEqual(self.client.calls[-1][1], "Gerald prefers concise plans.")
        self.assertEqual(self.client.calls[-1][3]["store"], "semantic")
        self.assertEqual(self.client.calls[-1][3]["category"], "person")
        self.assertIn("channel", self.client.calls[-1][3])

    def test_provider_session_end_checkpoint_includes_label(self):
        provider = plugin.MemoryCrystalProvider()
        provider.initialize("s1", platform="cli")
        provider.on_session_end([{"content": "User asked about Hermes."}, {"content": "Assistant answered."}])

        self.assertEqual(self.client.calls[-1][0], "checkpoint")
        self.assertEqual(self.client.calls[-1][3], "Hermes provider.on session end")
        self.assertIn("User asked about Hermes", self.client.calls[-1][4])

    def test_tool_bridge_uses_real_http_contract_paths(self):
        class CapturingClient(plugin.MemoryCrystalClient):
            def __init__(self):
                super().__init__(api_url="https://convex.example", api_key="mc_test")
                self.requests = []

            def request(self, path, payload=None, method="POST", timeout=None):
                self.requests.append((path, payload or {}, method))
                return {"ok": True, "path": path, "payload": payload or {}, "method": method}

        capturing = CapturingClient()
        plugin._CLIENT_FACTORY = lambda: capturing
        provider = plugin.MemoryCrystalProvider()
        provider.initialize("s1", platform="peer-coach", peer_id="511172388", agent_workspace="/tmp/memorycrystal")

        json.loads(provider.handle_tool_call("crystal_recent", {"limit": 2}))
        json.loads(provider.handle_tool_call("crystal_why_did_we", {"query": "ship?"}))
        json.loads(provider.handle_tool_call("crystal_preflight", {"query": "deploy"}))

        self.assertEqual(capturing.requests[0][0], "/api/mcp/recent-messages")
        self.assertEqual(capturing.requests[0][1]["sessionKey"], "s1")
        self.assertEqual(capturing.requests[0][1]["channel"], "hermes:peer-coach:511172388:memorycrystal")
        self.assertEqual(capturing.requests[1][0], "/api/mcp/recall")
        self.assertEqual(capturing.requests[1][1]["mode"], "decision")
        self.assertEqual(capturing.requests[1][1]["channel"], "hermes:peer-coach:511172388:memorycrystal")
        self.assertEqual(capturing.requests[2][0], "/api/mcp/recall")
        self.assertEqual(capturing.requests[2][1]["categories"], ["rule", "lesson", "decision"])

    def test_tool_bridge_preserves_explicit_scope(self):
        class CapturingClient(plugin.MemoryCrystalClient):
            def __init__(self):
                super().__init__(api_url="https://convex.example", api_key="mc_test")
                self.requests = []

            def request(self, path, payload=None, method="POST", timeout=None):
                self.requests.append((path, payload or {}, method))
                return {"ok": True}

        capturing = CapturingClient()
        plugin._CLIENT_FACTORY = lambda: capturing
        provider = plugin.MemoryCrystalProvider()
        provider.initialize("s1", platform="peer-coach", peer_id="511172388")

        provider.handle_tool_call("crystal_recall", {"query": "x", "channel": "explicit", "sessionKey": "explicit-session"})

        self.assertEqual(capturing.requests[0][1]["channel"], "explicit")
        self.assertEqual(capturing.requests[0][1]["sessionKey"], "explicit-session")

    def test_circuit_breaker_skips_after_failures(self):
        def failing_recall(*args, **kwargs):
            self.client.calls.append(("recall",) + args)
            return {"ok": False, "error": "backend down"}

        self.client.recall = failing_recall
        os.environ["MEMORY_CRYSTAL_FAILURE_THRESHOLD"] = "1"
        try:
            first = plugin.pre_llm_call("s1", "What is stored?", platform="cli")
            second = plugin.pre_llm_call("s1", "What is stored now?", platform="cli")

            self.assertIsNotNone(first)
            self.assertIsNotNone(second)
            self.assertEqual(len([call for call in self.client.calls if call[0] == "recall"]), 1)
            self.assertTrue(plugin.SESSIONS["s1"].circuit_failures >= 1)
            self.assertEqual(plugin.SESSIONS["s1"].last_skip_reason, "circuit_open")
        finally:
            os.environ.pop("MEMORY_CRYSTAL_FAILURE_THRESHOLD", None)

    def test_capture_disabled_reports_status(self):
        os.environ["MEMORY_CRYSTAL_CAPTURE_TURNS"] = "false"
        try:
            plugin.post_llm_call("s1", "remember this", "Done.", platform="cli")
            self.assertEqual(self.client.calls, [])
            self.assertEqual(plugin.SESSIONS["s1"].last_capture_mode, "disabled")
            self.assertFalse(json.loads(plugin.crystal_status())["captureTurns"])
        finally:
            os.environ.pop("MEMORY_CRYSTAL_CAPTURE_TURNS", None)


if __name__ == "__main__":
    unittest.main()
