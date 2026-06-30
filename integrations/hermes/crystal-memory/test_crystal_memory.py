import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import time
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

    def wake(self, session_id, channel, automatic=False, **kwargs):
        self.calls.append(("wake", session_id, channel, kwargs) if kwargs else ("wake", session_id, channel))
        return {"briefing": "Welcome back. Current project: Hermes integration."}

    def recall(self, query, session_id, channel, limit=6, automatic=False, **kwargs):
        self.calls.append(("recall", query, session_id, channel, limit, kwargs) if kwargs else ("recall", query, session_id, channel, limit))
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

    def log(self, role, content, session_id, channel, turn_index=None, **kwargs):
        self.calls.append(("log", role, content, session_id, channel, turn_index, kwargs) if kwargs else ("log", role, content, session_id, channel, turn_index))
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

    def snapshot(self, session_id, channel, reason, messages):
        self.calls.append(("snapshot", session_id, channel, reason, messages))
        return {"ok": True, "id": "s1"}

    def tool(self, tool_name, args):
        self.calls.append(("tool", tool_name, args))
        return {"ok": True, "tool": tool_name, "args": args}


class HermesPluginTests(unittest.TestCase):
    def setUp(self):
        self._env_snapshot = {
            key: value
            for key, value in os.environ.items()
            if key.startswith("MEMORY_CRYSTAL_") or key in {"CRYSTAL_CONVEX_URL", "HERMES_HOME", "HERMES_PROFILE"}
        }
        for key in list(os.environ):
            if key.startswith("MEMORY_CRYSTAL_") or key in {"CRYSTAL_CONVEX_URL", "HERMES_HOME", "HERMES_PROFILE"}:
                os.environ.pop(key, None)
        plugin._flush_capture_queue(0.2)
        plugin.CAPTURE_QUEUE = None
        plugin.CAPTURE_WORKER = None
        plugin.CAPTURE_DROPPED = 0
        plugin.CAPTURE_LAST_LATENCY_MS = None
        plugin.CAPTURE_LAST_FLUSH_RESULT = ""
        self.client = FakeClient()
        plugin.SESSIONS.clear()
        plugin.LAST_ERROR = ""
        plugin.ACTIVE_MODE = "unregistered"
        plugin.ACTIVE_MODE_REASON = ""
        plugin._CLIENT_FACTORY = lambda: self.client

    def tearDown(self):
        plugin._flush_capture_queue(1.0)
        plugin._CLIENT_FACTORY = None
        for key in list(os.environ):
            if key.startswith("MEMORY_CRYSTAL_") or key in {"CRYSTAL_CONVEX_URL", "HERMES_HOME", "HERMES_PROFILE"}:
                os.environ.pop(key, None)
        os.environ.update(self._env_snapshot)

    def flush_capture(self):
        self.assertTrue(plugin._flush_capture_queue(1.0))

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
        self.flush_capture()

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
        self.flush_capture()

        self.assertEqual(self.client.calls[0][5]["turn_id"], "hermes-turn-123")

    def test_post_llm_call_derives_stable_turn_id_for_same_content_retry(self):
        plugin.post_llm_call(
            session_id="s1",
            user_message="remember the plan",
            assistant_response="Done.",
            platform="gateway",
        )
        self.flush_capture()
        first_turn_id = self.client.calls[-1][5]["turn_id"]

        plugin.post_llm_call(
            session_id="s1",
            user_message="remember the plan",
            assistant_response="Done.",
            platform="gateway",
        )
        self.flush_capture()
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
        self.flush_capture()

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
            senderId="u1",
            channel_type="group",
            channel_id="c1",
        )

        self.assertEqual(self.client.calls, [])
        self.assertEqual(plugin.SESSIONS["s1"].last_capture_mode, "skipped")

    def test_post_llm_call_captures_group_writes_when_enabled(self):
        os.environ["MEMORY_CRYSTAL_ALLOW_GROUP_WRITES"] = "true"

        plugin.post_llm_call(
            session_id="s1",
            user_message="remember this",
            assistant_response="Done.",
            platform="discord",
            senderId="u1",
            channel_type="group",
            channel_id="c1",
        )
        self.flush_capture()

        self.assertEqual(self.client.calls[0][0], "turn")
        self.assertEqual(self.client.calls[0][2], f"discord:group:c1:{os.environ.get('USER') or 'local'}")
        self.assertEqual(self.client.calls[0][5]["external_user_id"], "u1")

    def test_hermes_propagates_agent_and_project_identity(self):
        os.environ["MEMORY_CRYSTAL_AGENT_ID"] = "codex-desktop"
        result = plugin.pre_llm_call(
            session_id="s1",
            user_message="What did we decide about this repo?",
            is_first_turn=True,
            platform="cli",
            agent_workspace="/tmp/cassai-v2",
        )

        self.assertIsInstance(result, dict)
        wake_call = self.client.calls[0]
        recall_call = self.client.calls[1]
        self.assertEqual(wake_call[0], "wake")
        self.assertEqual(wake_call[3]["agent_id"], "codex-desktop")
        self.assertEqual(wake_call[3]["project_context"]["repoSlug"], "cassai-v2")
        self.assertRegex(wake_call[3]["project_context"]["projectId"], r"^proj_[a-f0-9]{24}$")
        self.assertEqual(recall_call[5]["agent_id"], "codex-desktop")

        plugin.post_llm_call(
            session_id="s1",
            user_message="remember the repo plan",
            assistant_response="Done.",
            platform="gateway",
            user_id="gerald",
            agent_workspace="/tmp/cassai-v2",
        )
        self.flush_capture()

        turn_call = self.client.calls[-1]
        self.assertEqual(turn_call[0], "turn")
        self.assertEqual(turn_call[5]["agent_id"], "codex-desktop")
        self.assertEqual(turn_call[5]["project_context"]["repoSlug"], "cassai-v2")

    def test_agent_scope_env_participates_in_channel_derivation(self):
        os.environ["MEMORY_CRYSTAL_AGENT_SCOPE"] = "marcus"

        plugin.post_llm_call(
            session_id="s1",
            user_message="remember the plan",
            assistant_response="Done.",
            platform="gateway",
            externalUserId="gerald",
        )
        self.flush_capture()

        self.assertEqual(self.client.calls[0][1:5], ("s1", "hermes:gateway:gerald:marcus", "remember the plan", "Done."))
        self.assertEqual(self.client.calls[0][5]["external_user_id"], "gerald")

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
        self.flush_capture()

        self.assertIn("Hermes plan", context)
        self.assertEqual(self.client.calls[0][0], "wake")
        self.assertEqual(self.client.calls[-1][0], "turn")
        self.assertEqual(plugin.SESSIONS["s1"].hooks["provider.prefetch"], 1)
        self.assertEqual(plugin.SESSIONS["s1"].hooks["provider.sync_turn"], 1)

    def test_provider_config_schema_iterates_field_objects(self):
        provider = plugin.MemoryCrystalProvider()
        fields = provider.get_config_schema()

        expected_keys = [
            "api_key",
            "api_url",
            "mode",
            "capture_turns",
            "inject_recall",
            "allow_group_writes",
            "agent_scope",
            "provider_tools",
            "auto_recall_timeout",
            "capture_queue_size",
            "capture_shutdown_flush_timeout",
        ]
        self.assertEqual([field.name for field in fields], expected_keys)
        self.assertEqual([field.key for field in fields], expected_keys)
        self.assertEqual(fields[0]["env"], "MEMORY_CRYSTAL_API_KEY")
        self.assertEqual(fields[0]["env_var"], "MEMORY_CRYSTAL_API_KEY")
        self.assertEqual(fields[2]["env"], "MEMORY_CRYSTAL_HERMES_MODE")
        self.assertEqual(fields[3]["env_var"], "MEMORY_CRYSTAL_CAPTURE_TURNS")
        self.assertTrue(fields[0].secret)

    def test_provider_save_config_persists_all_schema_values(self):
        provider = plugin.MemoryCrystalProvider()
        with tempfile.TemporaryDirectory() as hermes_home:
            env_path = pathlib.Path(hermes_home) / ".env"
            env_path.write_text(
                "\n".join([
                    "KEEP_ME=1",
                    "MEMORY_CRYSTAL_API_KEY=old",
                    "MEMORY_CRYSTAL_API_URL=https://old.example",
                    "CRYSTAL_CONVEX_URL=https://old.example",
                    "MEMORY_CRYSTAL_CAPTURE_TURNS=false",
                    "MEMORY_CRYSTAL_AGENT_SCOPE=old",
                    "MEMORY_CRYSTAL_PROVIDER_TOOLS=always",
                    "",
                ]),
                encoding="utf-8",
            )

            result = provider.save_config(
                {
                    "api_key": "mc_test",
                    "api_url": "https://convex.example",
                    "mode": "provider",
                    "capture_turns": True,
                    "inject_recall": False,
                    "allow_group_writes": True,
                    "agent_scope": "marcus",
                    "provider_tools": "fallback",
                    "auto_recall_timeout": 2.5,
                    "capture_queue_size": 25,
                    "capture_shutdown_flush_timeout": 1.5,
                },
                hermes_home,
            )

            self.assertEqual(result["env"], str(env_path))
            contents = env_path.read_text(encoding="utf-8")
            self.assertIn("KEEP_ME=1", contents)
            self.assertIn("MEMORY_CRYSTAL_API_KEY=mc_test", contents)
            self.assertIn("MEMORY_CRYSTAL_API_URL=https://convex.example", contents)
            self.assertIn("CRYSTAL_CONVEX_URL=https://convex.example", contents)
            self.assertIn("MEMORY_CRYSTAL_HERMES_MODE=provider", contents)
            self.assertIn("MEMORY_CRYSTAL_CAPTURE_TURNS=true", contents)
            self.assertIn("MEMORY_CRYSTAL_INJECT_RECALL=false", contents)
            self.assertIn("MEMORY_CRYSTAL_ALLOW_GROUP_WRITES=true", contents)
            self.assertIn("MEMORY_CRYSTAL_AGENT_SCOPE=marcus", contents)
            self.assertIn("MEMORY_CRYSTAL_PROVIDER_TOOLS=fallback", contents)
            self.assertIn("MEMORY_CRYSTAL_AUTO_RECALL_TIMEOUT=2.5", contents)
            self.assertIn("MEMORY_CRYSTAL_CAPTURE_QUEUE_SIZE=25", contents)
            self.assertIn("MEMORY_CRYSTAL_CAPTURE_SHUTDOWN_FLUSH_TIMEOUT=1.5", contents)
            self.assertNotIn("old.example", contents)

    def test_provider_tool_bridge_returns_json_string(self):
        provider = plugin.MemoryCrystalProvider()
        result = json.loads(provider.handle_tool_call("crystal_stats", {}))

        self.assertTrue(result["success"])
        self.assertEqual(result["result"]["tool"], "crystal_stats")

    def test_provider_tool_schemas_are_exact_and_hidden_when_mcp_configured(self):
        provider = plugin.MemoryCrystalProvider()
        os.environ["MEMORY_CRYSTAL_MCP_CONFIGURED"] = "false"
        schemas = provider.get_tool_schemas()

        self.assertEqual([schema["name"] for schema in schemas], [
            "crystal_recall",
            "crystal_remember",
            "crystal_recent",
            "crystal_search_messages",
            "crystal_preflight",
            "crystal_stats",
            "crystal_wake",
        ])
        self.assertFalse(schemas[0]["parameters"]["additionalProperties"])

        os.environ["MEMORY_CRYSTAL_MCP_CONFIGURED"] = "true"
        self.assertEqual(provider.get_tool_schemas(), [])

        os.environ["MEMORY_CRYSTAL_PROVIDER_TOOLS"] = "always"
        self.assertNotEqual(provider.get_tool_schemas(), [])

    def test_provider_memory_write_maps_user_target(self):
        provider = plugin.MemoryCrystalProvider()
        provider.initialize("s1", platform="cli")
        provider.on_memory_write("add", "user", "Gerald prefers concise plans.", {"source": "unit"})

        self.assertEqual(self.client.calls[-1][0], "remember")
        self.assertEqual(self.client.calls[-1][1], "Gerald prefers concise plans.")
        self.assertEqual(self.client.calls[-1][3]["store"], "semantic")
        self.assertEqual(self.client.calls[-1][3]["category"], "person")
        self.assertIn("channel", self.client.calls[-1][3])

    def test_provider_session_end_writes_snapshot_not_checkpoint(self):
        provider = plugin.MemoryCrystalProvider()
        provider.initialize("s1", platform="cli")
        provider.on_session_end([{"content": "User asked about Hermes."}, {"content": "Assistant answered."}])

        self.assertEqual(self.client.calls[-1][0], "snapshot")
        self.assertEqual(self.client.calls[-1][3], "Hermes provider.on session end")
        self.assertEqual([message["content"] for message in self.client.calls[-1][4]], ["User asked about Hermes.", "Assistant answered."])
        self.assertNotIn("checkpoint", [call[0] for call in self.client.calls])

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

    def test_tool_bridge_preserves_backend_redacted_message_payloads(self):
        class RedactedClient(plugin.MemoryCrystalClient):
            def __init__(self):
                super().__init__(api_url="https://convex.example", api_key="mc_test")

            def request(self, path, payload=None, method="POST", timeout=None):
                return {
                    "ok": True,
                    "messages": [
                        {
                            "messageId": "m1",
                            "content": "deploy note github_pat_[REDACTED]",
                        }
                    ],
                }

        plugin._CLIENT_FACTORY = lambda: RedactedClient()
        provider = plugin.MemoryCrystalProvider()
        provider.initialize("s1", platform="peer-coach", peer_id="511172388")

        response = provider.handle_tool_call("crystal_search_messages", {"query": "deploy"})

        self.assertIn("github_pat_[REDACTED]", response)
        self.assertNotIn("github_pat_1234567890abcdefghijklmnopqrstuvwxyz", response)

    def test_default_recall_timeout_is_ten_seconds_for_wake_and_recall(self):
        class TimeoutClient(plugin.MemoryCrystalClient):
            def __init__(self):
                super().__init__(api_url="https://convex.example", api_key="mc_test")
                self.requests = []

            def request(self, path, payload=None, method="POST", timeout=None):
                self.requests.append((path, timeout))
                return {"ok": True}

        os.environ.pop("MEMORY_CRYSTAL_RECALL_TIMEOUT", None)
        client = TimeoutClient()

        client.wake("s1", "hermes:test")
        client.recall("what changed?", "s1", "hermes:test")

        self.assertEqual(client.requests, [
            ("/api/mcp/wake", 10.0),
            ("/api/mcp/recall", 10.0),
        ])

    def test_auto_recall_timeout_is_shorter_for_automatic_context(self):
        class TimeoutClient(plugin.MemoryCrystalClient):
            def __init__(self):
                super().__init__(api_url="https://convex.example", api_key="mc_test")
                self.requests = []

            def request(self, path, payload=None, method="POST", timeout=None):
                self.requests.append((path, timeout))
                return {"ok": True}

        client = TimeoutClient()

        client.wake("s1", "hermes:test", automatic=True)
        client.recall("what changed?", "s1", "hermes:test", automatic=True)

        self.assertEqual(client.requests, [
            ("/api/mcp/wake", 2.5),
            ("/api/mcp/recall", 2.5),
        ])

    def test_recall_uses_stale_context_when_backend_fails_after_success(self):
        calls = {"count": 0}

        def sometimes_failing_recall(query, session_id, channel, limit=6, automatic=False):
            calls["count"] += 1
            if calls["count"] == 1:
                return {
                    "memories": [{
                        "title": "Cached plan",
                        "content": "Use stale memory when refresh fails.",
                        "store": "semantic",
                        "category": "decision",
                    }]
                }
            return {"ok": False, "error": "timed out"}

        self.client.recall = sometimes_failing_recall

        first = plugin.pre_llm_call("s1", "What is the cached plan?", platform="cli")
        second = plugin.pre_llm_call("s1", "What else about the cached plan?", platform="cli")

        self.assertIn("Cached plan", first["context"])
        self.assertIn("Cached plan", second["context"])
        self.assertEqual(plugin.SESSIONS["s1"].last_recall_cache_status, "stale")
        self.assertEqual(plugin.SESSIONS["s1"].last_recall_degraded_reason, "timed out")

    def test_recall_timeout_env_override_still_works(self):
        class TimeoutClient(plugin.MemoryCrystalClient):
            def __init__(self):
                super().__init__(api_url="https://convex.example", api_key="mc_test")
                self.requests = []

            def request(self, path, payload=None, method="POST", timeout=None):
                self.requests.append((path, timeout))
                return {"ok": True}

        os.environ["MEMORY_CRYSTAL_RECALL_TIMEOUT"] = "12.5"
        try:
            client = TimeoutClient()
            client.recall("what changed?", "s1", "hermes:test")
            self.assertEqual(client.requests[-1], ("/api/mcp/recall", 12.5))
        finally:
            os.environ.pop("MEMORY_CRYSTAL_RECALL_TIMEOUT", None)

    def test_invalid_recall_timeout_env_falls_back_to_ten_seconds(self):
        class TimeoutClient(plugin.MemoryCrystalClient):
            def __init__(self):
                super().__init__(api_url="https://convex.example", api_key="mc_test")
                self.requests = []

            def request(self, path, payload=None, method="POST", timeout=None):
                self.requests.append((path, timeout))
                return {"ok": True}

        for value in ["", "not-a-number"]:
            with self.subTest(value=value):
                os.environ["MEMORY_CRYSTAL_RECALL_TIMEOUT"] = value
                try:
                    client = TimeoutClient()
                    client.wake("s1", "hermes:test")
                    self.assertEqual(client.requests[-1], ("/api/mcp/wake", 10.0))
                finally:
                    os.environ.pop("MEMORY_CRYSTAL_RECALL_TIMEOUT", None)

    def test_non_positive_recall_timeout_env_falls_back_to_ten_seconds(self):
        class TimeoutClient(plugin.MemoryCrystalClient):
            def __init__(self):
                super().__init__(api_url="https://convex.example", api_key="mc_test")
                self.requests = []

            def request(self, path, payload=None, method="POST", timeout=None):
                self.requests.append((path, timeout))
                return {"ok": True}

        for value in ["0", "-1"]:
            with self.subTest(value=value):
                os.environ["MEMORY_CRYSTAL_RECALL_TIMEOUT"] = value
                try:
                    client = TimeoutClient()
                    client.recall("what changed?", "s1", "hermes:test")
                    self.assertEqual(client.requests[-1], ("/api/mcp/recall", 10.0))
                finally:
                    os.environ.pop("MEMORY_CRYSTAL_RECALL_TIMEOUT", None)

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

    def test_capture_queue_full_reports_drop(self):
        os.environ["MEMORY_CRYSTAL_CAPTURE_QUEUE_SIZE"] = "1"
        plugin.CAPTURE_QUEUE = None

        def slow_turn(*args, **kwargs):
            time.sleep(0.05)
            self.client.calls.append(("turn",) + args)
            return {"ok": True}

        self.client.turn = slow_turn
        plugin.post_llm_call("s1", "first", "one", platform="cli")
        plugin.post_llm_call("s1", "second", "two", platform="cli")
        plugin.post_llm_call("s1", "third", "three", platform="cli")

        plugin._flush_capture_queue(1.0)
        status = json.loads(plugin.crystal_status())

        self.assertGreaterEqual(status["captureDropped"], 1)

    def test_crystal_doctor_returns_human_readable_rows(self):
        plugin.ACTIVE_MODE = "provider"
        plugin.ACTIVE_MODE_REASON = "registered via ctx.register_memory_provider"

        doctor = plugin.crystal_doctor()

        self.assertIn("Memory Crystal Doctor", doctor)
        self.assertIn("[PASS] plugin", doctor)
        self.assertIn("capture queue", doctor)


if __name__ == "__main__":
    unittest.main()
