import ast
import hashlib
import threading
from unittest.mock import patch
import importlib.util
import json
import os
import pathlib
import queue
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


class StoppableTestQueue(queue.Queue):
    def get(self, *args, **kwargs):
        item = super().get(*args, **kwargs)
        if item is None:
            self.task_done()
            raise SystemExit
        return item


class PluginTestFixture(unittest.TestCase):
    def setUp(self):
        self._env_snapshot = {
            key: value
            for key, value in os.environ.items()
            if key.startswith("MEMORY_CRYSTAL_") or key in {"CRYSTAL_CONVEX_URL", "HERMES_HOME", "HERMES_PROFILE"}
        }
        for key in list(os.environ):
            if key.startswith("MEMORY_CRYSTAL_") or key in {"CRYSTAL_CONVEX_URL", "HERMES_HOME", "HERMES_PROFILE"}:
                os.environ.pop(key, None)
        os.environ["MEMORY_CRYSTAL_INJECT_RECALL"] = "true"
        plugin._prefetch_reset()
        self._capture_queue_factory = plugin._capture_queue
        def capture_queue():
            if plugin.CAPTURE_QUEUE is None:
                plugin.CAPTURE_QUEUE = StoppableTestQueue(maxsize=plugin._capture_queue_size())
            return plugin.CAPTURE_QUEUE
        plugin._capture_queue = capture_queue
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
        plugin._prefetch_reset()
        plugin._flush_capture_queue(1.0)
        worker = plugin.CAPTURE_WORKER
        if worker is not None:
            plugin.CAPTURE_QUEUE.put(None)
            worker.join(2)
            self.assertFalse(worker.is_alive())
        plugin._capture_queue = self._capture_queue_factory
        plugin._CLIENT_FACTORY = None
        for key in list(os.environ):
            if key.startswith("MEMORY_CRYSTAL_") or key in {"CRYSTAL_CONVEX_URL", "HERMES_HOME", "HERMES_PROFILE"}:
                os.environ.pop(key, None)
        os.environ.update(self._env_snapshot)

    def flush_capture(self):
        self.assertTrue(plugin._flush_capture_queue(1.0))

    def _wait_prefetch(self, timeout=1.0):
        self.assertTrue(plugin._prefetch_wait_idle(timeout))

class HermesPluginTests(PluginTestFixture):
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
        # AC10: cache miss returns preamble/tools only (no memories on first call)
        self.assertNotIn("Hermes plan", context)
        self._wait_prefetch()
        # Daemon should have populated state with wake and recall results
        self.assertIn("Hermes plan", plugin.SESSIONS["s1"].last_recall_context)
        self.assertEqual(plugin.SESSIONS["s1"].last_recall_cache_status, "miss")
        self.assertFalse(plugin.SESSIONS["s1"].wake_injected)
        second = plugin.pre_llm_call(session_id="s1", user_message="What did we decide about Hermes?", platform="cli")
        self.assertIn("Welcome back. Current project: Hermes integration.", second["context"])
        self.assertTrue(plugin.SESSIONS["s1"].wake_injected)


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
            agent_workspace="/tmp/acme-app",
        )

        self.assertIsInstance(result, dict)
        # AC10: cache miss returns immediately; daemon thread handles wake+recall
        self._wait_prefetch()
        wake_call = [c for c in self.client.calls if c[0] == "wake"][0]
        recall_call = [c for c in self.client.calls if c[0] == "recall"][0]
        self.assertEqual(wake_call[0], "wake")
        self.assertEqual(wake_call[3]["agent_id"], "codex-desktop")
        self.assertEqual(wake_call[3]["project_context"]["repoSlug"], "acme-app")
        self.assertRegex(wake_call[3]["project_context"]["projectId"], r"^proj_[a-f0-9]{24}$")
        self.assertEqual(recall_call[5]["agent_id"], "codex-desktop")

        plugin.post_llm_call(
            session_id="s1",
            user_message="remember the repo plan",
            assistant_response="Done.",
            platform="gateway",
            user_id="gerald",
            agent_workspace="/tmp/acme-app",
        )
        self.flush_capture()

        turn_call = self.client.calls[-1]
        self.assertEqual(turn_call[0], "turn")
        self.assertEqual(turn_call[5]["agent_id"], "codex-desktop")
        self.assertEqual(turn_call[5]["project_context"]["repoSlug"], "acme-app")

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

        # AC10: cache miss returns preamble/tools only
        context1 = provider.prefetch("What did we decide?")
        self.assertIn("Active Memory Backend", context1)
        # Wait for daemon prefetch to complete
        self._wait_prefetch()

        # Second call: context available from daemon
        context2 = provider.prefetch("What did we decide?")
        provider.sync_turn("Remember this", "Saved.")
        self.flush_capture()

        self.assertIn("Hermes plan", context2)
        self.assertEqual(self.client.calls[0][0], "wake")
        self.assertEqual(self.client.calls[-1][0], "turn")
        self.assertEqual(plugin.SESSIONS["s1"].hooks["provider.prefetch"], 2)
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
            "agent_pool",
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

    def test_provider_save_config_writes_agent_pool_once(self):
        provider = plugin.MemoryCrystalProvider()
        with tempfile.TemporaryDirectory() as hermes_home:
            env_path = pathlib.Path(hermes_home) / ".env"
            env_path.write_text("MEMORY_CRYSTAL_AGENT_POOL=layer\n", encoding="utf-8")
            provider.save_config({"agent_pool": "account"}, hermes_home)
            self.assertEqual(env_path.read_text(encoding="utf-8"), "MEMORY_CRYSTAL_AGENT_POOL=account\n")
            provider.save_config({"api_key": "mc_test"}, hermes_home)
            self.assertIn("MEMORY_CRYSTAL_AGENT_POOL=account", env_path.read_text(encoding="utf-8"))

    def _capturing_client(self):
        class CapturingClient(plugin.MemoryCrystalClient):
            def __init__(self):
                super().__init__(api_url="https://convex.example", api_key="mc_test")
                self.requests = []

            def request(self, path, payload=None, method="POST", timeout=None):
                self.requests.append((path, dict(payload or {})))
                return {"ok": True, "memories": []}

        capturing = CapturingClient()
        plugin._CLIENT_FACTORY = lambda: capturing
        return capturing

    def test_recall_sends_agent_pool_with_agent_id_on_every_recall_path(self):
        # ILL-477: recall opts into the per-agent layer whenever it names an agent.
        for env_value, expected in ((None, "layer"), ("account", "account"), (" Agent ", "agent"), ("LAYER", "layer"), ("bogus", "layer"), ("", "layer")):
            with self.subTest(env=env_value):
                os.environ.pop("MEMORY_CRYSTAL_AGENT_POOL", None)
                if env_value is not None:
                    os.environ["MEMORY_CRYSTAL_AGENT_POOL"] = env_value
                os.environ["MEMORY_CRYSTAL_AGENT_ID"] = "iris"
                plugin.SESSIONS.clear()
                plugin._prefetch_reset()
                capturing = self._capturing_client()

                plugin.pre_llm_call(session_id="s-auto", user_message="What did we decide about the launch plan?", is_first_turn=True, platform="cli")
                self._wait_prefetch()
                capturing.recall("launch plan", "s-explicit", "hermes:cli", agent_id="iris")
                plugin.MemoryCrystalProvider().handle_tool_call("crystal_recall", {"query": "launch plan"})

                recalls = [payload for path, payload in capturing.requests if path == "/api/mcp/recall"]
                self.assertEqual(len(recalls), 3)
                for payload in recalls:
                    self.assertEqual(payload["agentId"], "iris")
                    self.assertEqual(payload["agentPool"], expected)

    def test_recall_without_agent_id_sends_no_agent_pool(self):
        os.environ["MEMORY_CRYSTAL_AGENT_POOL"] = "agent"
        capturing = self._capturing_client()

        plugin.pre_llm_call(session_id="s-auto", user_message="What did we decide about the launch plan?", is_first_turn=True, platform="cli")
        self._wait_prefetch()
        capturing.recall("launch plan", "s-explicit", "hermes:cli")
        plugin.MemoryCrystalProvider().handle_tool_call("crystal_recall", {"query": "launch plan"})

        recalls = [payload for path, payload in capturing.requests if path == "/api/mcp/recall"]
        self.assertEqual(len(recalls), 3)
        for payload in recalls:
            self.assertNotIn("agentId", payload)
            self.assertNotIn("agentPool", payload)

    def test_agent_pool_stays_off_wake_log_turn_and_capture(self):
        os.environ["MEMORY_CRYSTAL_AGENT_ID"] = "iris"
        capturing = self._capturing_client()

        capturing.wake("s1", "hermes:cli", agent_id="iris")
        capturing.log("user", "hello", "s1", "hermes:cli", agent_id="iris")
        capturing.turn("s1", "hermes:cli", "hi", "hello", turn_id="t1", agent_id="iris")
        capturing.remember("title", "content", {"agentId": "iris"})
        provider = plugin.MemoryCrystalProvider()
        provider.handle_tool_call("crystal_wake", {})
        provider.handle_tool_call("crystal_remember", {"title": "t", "content": "c"})

        self.assertEqual([path for path, _ in capturing.requests], [
            "/api/mcp/wake", "/api/mcp/log", "/api/mcp/turn", "/api/mcp/capture", "/api/mcp/wake", "/api/mcp/capture",
        ])
        for path, payload in capturing.requests:
            self.assertEqual(payload["agentId"], "iris", path)
            self.assertNotIn("agentPool", payload, path)

    def test_provider_tool_bridge_returns_json_string(self):
        provider = plugin.MemoryCrystalProvider()
        result = json.loads(provider.handle_tool_call("crystal_stats", {}))

        self.assertTrue(result["success"])
        self.assertEqual(result["result"]["tool"], "crystal_stats")

    def test_client_rejects_retired_graph_tools(self):
        client = plugin.MemoryCrystalClient(api_url="https://convex.example", api_key="mc_test")
        for tool_name in (
            "crystal_who_owns",
            "crystal_explain_connection",
            "crystal_dependency_chain",
            "crystal_ideas",
            "crystal_idea_action",
        ):
            result = client.tool(tool_name, {})
            self.assertEqual(result, {"ok": False, "error": f"unknown tool: {tool_name}"})

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

    def test_tool_bridge_forwards_recall_scope_and_agent_id_on_by_id_tools(self):
        # ILL-319: forget and trace carry the same channel scope and resolved
        # agentId as recall, so the backend's by-id visibility gate sees what
        # recall would see.
        class CapturingClient(plugin.MemoryCrystalClient):
            def __init__(self):
                super().__init__(api_url="https://convex.example", api_key="mc_test")
                self.requests = []

            def request(self, path, payload=None, method="POST", timeout=None):
                self.requests.append((path, payload or {}, method))
                return {"ok": True}

        previous = os.environ.get("MEMORY_CRYSTAL_AGENT_ID")
        os.environ["MEMORY_CRYSTAL_AGENT_ID"] = "codex-desktop"
        try:
            capturing = CapturingClient()
            plugin._CLIENT_FACTORY = lambda: capturing
            provider = plugin.MemoryCrystalProvider()
            provider.initialize("s1", platform="peer-coach", peer_id="511172388", agent_workspace="/tmp/memorycrystal")

            provider.handle_tool_call("crystal_recall", {"query": "birthdays"})
            provider.handle_tool_call("crystal_forget", {"memoryId": "mem-1"})
            provider.handle_tool_call("crystal_trace", {"memoryId": "mem-1"})
            provider.handle_tool_call("crystal_trace", {"memoryId": "mem-1", "agentId": "explicit-agent"})
        finally:
            if previous is None:
                os.environ.pop("MEMORY_CRYSTAL_AGENT_ID", None)
            else:
                os.environ["MEMORY_CRYSTAL_AGENT_ID"] = previous

        recall_path, recall_payload, _ = capturing.requests[0]
        self.assertEqual(recall_path, "/api/mcp/recall")
        self.assertEqual(recall_payload["channel"], "hermes:peer-coach:511172388:memorycrystal")
        self.assertEqual(recall_payload["agentId"], "codex-desktop")
        for path, payload, _ in capturing.requests[1:3]:
            self.assertIn(path, {"/api/mcp/forget", "/api/mcp/trace"})
            self.assertEqual(payload["memoryId"], "mem-1")
            self.assertEqual(payload["channel"], recall_payload["channel"])
            self.assertEqual(payload["agentId"], recall_payload["agentId"])
        self.assertEqual(capturing.requests[3][1]["agentId"], "explicit-agent")

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

    def test_auto_recall_timeout_default_is_sixteen_seconds(self):
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
            ("/api/mcp/wake", 16.0),
            ("/api/mcp/recall", 16.0),
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

        # AC10: cache miss returns preamble/tools only; daemon populates state
        first = plugin.pre_llm_call("s1", "What is the cached plan?", platform="cli")
        self.assertIn("Active Memory Backend", first["context"])
        self.assertNotIn("Cached plan", first["context"])
        self._wait_prefetch()
        # First daemon succeeded, state now has cached plan
        self.assertIn("Cached plan", plugin.SESSIONS["s1"].last_recall_context)

        # Second call (same query) — daemon from first call set cache, so second
        # call hits stale path and returns cached plan immediately
        second = plugin.pre_llm_call("s1", "What else about the cached plan?", platform="cli")
        self.assertIn("Cached plan", second["context"])
        self.assertEqual(plugin.SESSIONS["s1"].last_recall_cache_status, "stale")
        # AC10: stale path returns immediately without attempting recall on the
        # calling thread; the daemon prefetch thread records failure asynchronously.



    def test_pre_llm_call_returns_without_blocking_when_stale_context_exists(self):
        """AC10: pre_llm_call returns stale context without waiting on a slow recall."""
        # First call: cache miss returns preamble/tools only, daemon fills state
        first = plugin.pre_llm_call("s1", "What is the plan?", platform="cli")
        self.assertIn("Active Memory Backend", first["context"])
        self._wait_prefetch()
        self.assertIn("Hermes plan", plugin.SESSIONS["s1"].last_recall_context)
        self.assertEqual(plugin.SESSIONS["s1"].last_recall_cache_status, "miss")
        first_context = plugin.SESSIONS["s1"].last_recall_context
        self.assertTrue(first_context)

        # Replace client with a deliberately slow version
        slow_client = FakeClient()
        orig_recall = slow_client.recall
        def slow_recall(*args, **kwargs):
            import time
            time.sleep(0.5)
            return orig_recall(*args, **kwargs)
        slow_client.recall = slow_recall
        plugin._CLIENT_FACTORY = lambda: slow_client

        # Second call must return immediately with stale context
        start = time.time()
        second = plugin.pre_llm_call("s1", "What else about the plan?", platform="cli")
        elapsed = time.time() - start

        self.assertIn("Hermes plan", second["context"])
        self.assertEqual(plugin.SESSIONS["s1"].last_recall_cache_status, "stale")
        self.assertLess(elapsed, 0.2, f"pre_llm_call blocked on recall for {elapsed:.3f}s")
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
            # AC10: cache miss returns immediately; daemon records failure
            first = plugin.pre_llm_call("s1", "What is stored?", platform="cli")
            self.assertIsNotNone(first)
            self._wait_prefetch()
            # Daemon recall call counted
            self.assertEqual(len([call for call in self.client.calls if call[0] == "recall"]), 1)
            self.assertTrue(plugin.SESSIONS["s1"].circuit_failures >= 1)

            # Second call — circuit now open, should skip
            second = plugin.pre_llm_call("s1", "What is stored now?", platform="cli")
            self.assertIsNotNone(second)
            self.assertEqual(len([call for call in self.client.calls if call[0] == "recall"]), 1)
            self.assertEqual(plugin.SESSIONS["s1"].last_skip_reason, "circuit_open")
        finally:
            os.environ.pop("MEMORY_CRYSTAL_FAILURE_THRESHOLD", None)

    def test_default_failure_threshold_is_five_hard_failures(self):
        def failing_recall(*args, **kwargs):
            self.client.calls.append(("recall",) + args)
            return {"ok": False, "error": "backend down"}

        self.client.recall = failing_recall
        for index in range(6):
            plugin.pre_llm_call("s1", f"What is stored? attempt {index}", platform="cli")
            self._wait_prefetch()

        # 5 hard failures open the breaker; the 6th call is skipped.
        self.assertEqual(len([call for call in self.client.calls if call[0] == "recall"]), 5)
        self.assertEqual(plugin.SESSIONS["s1"].circuit_failures, 5)
        self.assertEqual(plugin.SESSIONS["s1"].last_skip_reason, "circuit_open")

    def test_timeouts_count_separately_and_do_not_slam_the_breaker(self):
        def timing_out_recall(*args, **kwargs):
            self.client.calls.append(("recall",) + args)
            return {"ok": False, "error": "timed out", "timedOut": True}

        self.client.recall = timing_out_recall
        for index in range(6):
            plugin.pre_llm_call("s1", f"What is stored? attempt {index}", platform="cli")
            self._wait_prefetch()

        state = plugin.SESSIONS["s1"]
        # Six consecutive timeouts: the hard-failure counter stays untouched and
        # the breaker stays CLOSED (timeout threshold defaults to 10).
        self.assertEqual(state.circuit_failures, 0)
        self.assertEqual(state.circuit_timeouts, 6)
        self.assertEqual(len([call for call in self.client.calls if call[0] == "recall"]), 6)
        self.assertFalse(plugin._circuit_open(state))

        for index in range(4):
            plugin.pre_llm_call("s1", f"Still stored? attempt {index}", platform="cli")
            self._wait_prefetch()

        # At 10 consecutive timeouts the timeout breaker finally opens.
        self.assertEqual(state.circuit_timeouts, 10)
        self.assertTrue(plugin._circuit_open(state))

    def test_success_resets_both_circuit_counters(self):
        state = plugin._session_state("s1")
        state.circuit_failures = 2
        state.circuit_timeouts = 4
        plugin._record_backend_result(state, "s1", {"ok": True})
        self.assertEqual(state.circuit_failures, 0)
        self.assertEqual(state.circuit_timeouts, 0)

    def test_request_tags_timeouts_for_the_split_breaker(self):
        client = plugin.MemoryCrystalClient(api_url="https://convex.example", api_key="mc_test")

        def raise_timeout(*args, **kwargs):
            raise TimeoutError("timed out")

        original_urlopen = plugin.urllib.request.urlopen
        plugin.urllib.request.urlopen = raise_timeout
        try:
            payload = client.request("/api/mcp/recall", {"query": "x"})
        finally:
            plugin.urllib.request.urlopen = original_urlopen

        self.assertIs(payload.get("timedOut"), True)
        self.assertFalse(payload.get("ok"))

    def test_recall_defaults_surface_twelve_memories_with_800_char_previews(self):
        long_content = "x" * 2000

        def many_memories_recall(query, session_id, channel, limit=None, automatic=False, **kwargs):
            self.client.calls.append(("recall", query, session_id, channel, limit))
            return {
                "memories": [
                    {"title": f"Memory {index}", "content": f"{index}:{long_content}", "store": "semantic", "category": "fact"}
                    for index in range(15)
                ]
            }

        self.client.recall = many_memories_recall
        # AC10: cache miss returns preamble/tools; daemon fills cache
        plugin.pre_llm_call("s1", "What do we know about the atlas rollout?", platform="cli")
        self._wait_prefetch()

        recall_call = [call for call in self.client.calls if call[0] == "recall"][-1]
        self.assertEqual(recall_call[4], 12)

        # Second call uses cached result
        result = plugin.pre_llm_call("s1", "What do we know about the atlas rollout?", platform="cli")
        context = result["context"]
        listed = [line for line in context.splitlines() if line.startswith("- [semantic/fact]")]
        self.assertEqual(len(listed), 12)
        # Preview cap: title + 800-char content slice per row (not the old 360).
        first_row = listed[0]
        self.assertIn("0:" + "x" * (800 - len("0:")), first_row)
        self.assertLess(len(first_row), 950)

    def test_max_memories_and_preview_chars_env_overrides(self):
        os.environ["MEMORY_CRYSTAL_MAX_MEMORIES"] = "2"
        os.environ["MEMORY_CRYSTAL_PREVIEW_CHARS"] = "40"

        def many_memories_recall(query, session_id, channel, limit=None, automatic=False, **kwargs):
            self.client.calls.append(("recall", query, session_id, channel, limit))
            return {
                "memories": [
                    {"title": f"Memory {index}", "content": "y" * 500, "store": "semantic", "category": "fact"}
                    for index in range(5)
                ]
            }

        self.client.recall = many_memories_recall
        # AC10: cache miss returns preamble/tools; daemon fills cache
        plugin.pre_llm_call("s1", "What do we know about the atlas rollout?", platform="cli")
        self._wait_prefetch()

        recall_call = [call for call in self.client.calls if call[0] == "recall"][-1]
        self.assertEqual(recall_call[4], 2)

        # Second call uses cached result
        result = plugin.pre_llm_call("s1", "What do we know about the atlas rollout?", platform="cli")
        listed = [line for line in result["context"].splitlines() if line.startswith("- [semantic/fact]")]
        self.assertEqual(len(listed), 2)
        self.assertIn("y" * 40, listed[0])
        self.assertNotIn("y" * 41, listed[0])

    def test_default_context_budget_is_twelve_thousand_five_hundred_chars(self):
        self.assertEqual(plugin._context_budget(), 12500)
        long_parts = ["z" * 20000]
        bounded = plugin._bounded_context(long_parts)
        self.assertLessEqual(len(bounded), 12500)
        self.assertIn("[Memory Crystal context trimmed for budget.]", bounded)

    def test_agent_id_defaults_to_hermes_profile_when_unset(self):
        os.environ["HERMES_PROFILE"] = "Coach Profile"
        result = plugin.pre_llm_call(
            session_id="s1",
            user_message="What did we decide about Hermes?",
            is_first_turn=True,
            platform="cli",
        )

        self.assertIsInstance(result, dict)
        self._wait_prefetch()
        wake_call = [call for call in self.client.calls if call[0] == "wake"][0]
        self.assertEqual(wake_call[3]["agent_id"], "coach-profile")

    def test_explicit_agent_id_beats_profile_fallback(self):
        os.environ["HERMES_PROFILE"] = "coach"
        os.environ["MEMORY_CRYSTAL_AGENT_ID"] = "codex-desktop"
        plugin.pre_llm_call(
            session_id="s1",
            user_message="What did we decide about Hermes?",
            is_first_turn=True,
            platform="cli",
        )

        self._wait_prefetch()
        wake_call = [call for call in self.client.calls if call[0] == "wake"][0]
        self.assertEqual(wake_call[3]["agent_id"], "codex-desktop")

    def test_status_reports_effective_group_writes(self):
        for value, expected in [(None, False), ("true", True), ("false", False)]:
            with self.subTest(value=value):
                if value is None:
                    os.environ.pop("MEMORY_CRYSTAL_ALLOW_GROUP_WRITES", None)
                else:
                    os.environ["MEMORY_CRYSTAL_ALLOW_GROUP_WRITES"] = value
                self.assertEqual(json.loads(plugin.crystal_status())["allowGroupWrites"], expected)

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


    def test_pre_llm_call_cache_miss_does_not_await_wake_or_recall(self):
        """AC10: first pre_llm_call with empty cache returns immediately (preamble/tools only)."""
        # Replace client wake and recall with deliberately slow versions
        slow_client = FakeClient()
        _wake_captured = slow_client.wake
        _recall_captured = slow_client.recall
        def _slow_wake(*a, **kw):
            time.sleep(0.5)
            return _wake_captured(*a, **kw)
        def _slow_recall(*a, **kw):
            time.sleep(0.5)
            return _recall_captured(*a, **kw)
        slow_client.wake = _slow_wake
        slow_client.recall = _slow_recall
        plugin._CLIENT_FACTORY = lambda: slow_client

        start = time.time()
        result = plugin.pre_llm_call(
            session_id="s1",
            user_message="What did we decide about Hermes?",
            is_first_turn=True,
            platform="cli",
        )
        elapsed = time.time() - start

        self.assertIsInstance(result, dict)
        context = result["context"]
        self.assertIn("Active Memory Backend", context)
        self.assertIn("Memory Tool Discipline", context)
        # No live memories on first cache miss
        self.assertNotIn("Hermes plan", context)
        # Must not block on wake or recall
        self.assertLess(elapsed, 0.2, f"pre_llm_call blocked on wake/recall for {elapsed:.3f}s")

        self._wait_prefetch()
        # Daemon should have populated cache state
        self.assertIn("Hermes plan", plugin.SESSIONS["s1"].last_recall_context)

    def test_pre_llm_call_cache_miss_then_cache_hit_on_second_call(self):
        """AC10: second call after cache miss returns cached memories from daemon."""
        # First call: cache miss
        first = plugin.pre_llm_call("s1", "What is the plan?", platform="cli")
        self.assertNotIn("Hermes plan", first["context"])
        self._wait_prefetch()

        # Second call: should hit cache
        second = plugin.pre_llm_call("s1", "What is the plan?", platform="cli")
        self.assertIsInstance(second, dict)
        self.assertIn("Hermes plan", second["context"])
        self.assertEqual(plugin.SESSIONS["s1"].last_recall_cache_status, "hit")





# Exact circuit contract from a0d5a86f.
CIRCUIT_CONTRACT = """def _circuit_open(state: SessionState) -> bool:
    failures_tripped = state.circuit_failures >= _failure_threshold()
    timeouts_tripped = state.circuit_timeouts >= _timeout_failure_threshold()
    if not failures_tripped and not timeouts_tripped:
        return False
    cooldown = _env_float("MEMORY_CRYSTAL_CIRCUIT_COOLDOWN", DEFAULT_CIRCUIT_COOLDOWN)
    if time.time() - state.circuit_opened_at > cooldown:
        state.circuit_failures = 0
        state.circuit_timeouts = 0
        state.circuit_opened_at = 0.0
        return False
    return True


def _is_timeout_error(payload_error: Any) -> bool:
    error = str(payload_error or "").lower()
    return "timed out" in error or "timeout" in error


def _record_circuit_failure(state: SessionState, *, timed_out: bool) -> None:
    # Timeouts and hard errors count separately: slow responses need many more
    # consecutive occurrences than hard failures before the breaker opens.
    if timed_out:
        state.circuit_timeouts += 1
        if state.circuit_timeouts >= _timeout_failure_threshold():
            state.circuit_opened_at = time.time()
    else:
        state.circuit_failures += 1
        if state.circuit_failures >= _failure_threshold():
            state.circuit_opened_at = time.time()


def _record_backend_result(state: SessionState, session_id: str | None, payload: dict[str, Any]) -> None:
    if payload.get("error") or payload.get("ok") is False:
        timed_out = payload.get("timedOut") is True or _is_timeout_error(payload.get("error"))
        _record_circuit_failure(state, timed_out=timed_out)
        _record_error(session_id, payload.get("error") or "backend request failed")
    else:
        state.circuit_failures = 0
        state.circuit_timeouts = 0
        state.circuit_opened_at = 0.0

"""


def global_assignment_offenders(source):
    tree = ast.parse(source)
    def bindings(nodes):
        assigned, declared = set(), set()

        def visit(node):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                return
            if isinstance(node, ast.Global):
                declared.update(node.names)
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                assigned.add(node.id)
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                for alias in node.names:
                    assigned.add(alias.asname or (alias.name.split(".")[0]
                                 if isinstance(node, ast.Import) else alias.name))
            if isinstance(node, ast.ExceptHandler) and node.name:
                assigned.add(node.name)
            if isinstance(node, ast.comprehension):
                # Targets are local to the comprehension; walruses in its
                # expressions still bind in the containing scope.
                visit(node.iter)
                for condition in node.ifs:
                    visit(condition)
                return
            for child in ast.iter_child_nodes(node):
                visit(child)

        for node in nodes:
            visit(node)
        return assigned, declared

    module_names, _ = bindings(tree.body)
    names = {name for name in module_names if name.lstrip("_").isupper()}
    offenders = []
    for function in ast.walk(tree):
        if isinstance(function, (ast.FunctionDef, ast.AsyncFunctionDef)):
            assigned, declared = bindings(function.body)
            offenders.extend(f"{function.name}:{name}" for name in sorted((assigned & names) - declared))
    return sorted(offenders)


class PrefetchTests(PluginTestFixture):
    def gate(self):
        event = threading.Event()
        self.addCleanup(event.set)
        return event

    def block_client(self, blocked_session=None):
        entered, release = self.gate(), self.gate()
        original = self.client.recall
        def recall(query, session, *args, **kwargs):
            if blocked_session is None or session == blocked_session:
                entered.set()
                if not release.wait(2):
                    raise TimeoutError("test gate expired")
            return original(query, session, *args, **kwargs)
        self.client.recall = recall
        return entered, release

    def submit(self, session, query="q1"):
        plugin._prefetch_recall(session, "test", self.client, query, query)

    def test_two_sessions(self):
        entered, release = self.block_client("a")
        second = self.gate()
        original = self.client.recall
        def recall(query, session, *args, **kwargs):
            result = original(query, session, *args, **kwargs)
            if session == "b": second.set()
            return result
        self.client.recall = recall
        try:
            self.submit("a")
            self.assertTrue(entered.wait(1))
            self.submit("b")
            self.assertTrue(second.wait(1))
            with plugin._PREFETCH_CONDITION:
                self.assertTrue(plugin._PREFETCH_CONDITION.wait_for(
                    lambda: bool(plugin.SESSIONS["b"].last_recall_context), 1))
        finally:
            release.set()
        self._wait_prefetch()

    def test_coalescing(self):
        entered, release = self.block_client("a")
        try:
            self.submit("a")
            self.assertTrue(entered.wait(1))
            for query in ("q2", "q3", "q4"): self.submit("a", query)
        finally: release.set()
        self._wait_prefetch()
        self.assertEqual([c[1] for c in self.client.calls if c[0] == "recall"], ["q1", "q4"])
        self.assertIn("Hermes plan", plugin.SESSIONS["a"].recall_cache["q4"])

    def test_queued_replacement(self):
        os.environ["MEMORY_CRYSTAL_PREFETCH_WORKERS"] = "1"
        entered, release = self.block_client("b")
        try:
            self.submit("b")
            self.assertTrue(entered.wait(1))
            for query in ("q1", "q2", "q3", "q4"): self.submit("a", query)
        finally: release.set()
        self._wait_prefetch()
        self.assertEqual([c[1] for c in self.client.calls if c[0] == "recall" and c[2] == "a"], ["q4"])

    def test_pool_bound(self):
        os.environ["MEMORY_CRYSTAL_PREFETCH_WORKERS"] = "2"
        release, two = self.gate(), self.gate()
        lock = threading.Lock()
        active = maximum = 0
        original = self.client.recall
        def recall(*args, **kwargs):
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
                if active >= 2: two.set()
            try:
                if not release.wait(2): raise TimeoutError("test gate expired")
                return original(*args, **kwargs)
            finally:
                with lock: active -= 1
        self.client.recall = recall
        try:
            for i in range(5): self.submit(str(i))
            self.assertTrue(two.wait(1))
            self.assertFalse(plugin._prefetch_wait_idle(.01))
        finally: release.set()
        self._wait_prefetch()
        self.assertEqual(maximum, 2)
        self.assertEqual(len(plugin._PREFETCH_WORKERS), 2)
        self.assertTrue(all(w.daemon for w in plugin._PREFETCH_WORKERS))
        self.assertTrue(all(plugin.SESSIONS[str(i)].last_recall_context for i in range(5)))

    def test_env_and_concurrent_start(self):
        for value, expected in [(None,4),("",4),("0",4),("-3",4),("abc",4),("100",16),("1",1)]:
            with self.subTest(value=value):
                plugin._prefetch_reset()
                if value is None: os.environ.pop("MEMORY_CRYSTAL_PREFETCH_WORKERS", None)
                else: os.environ["MEMORY_CRYSTAL_PREFETCH_WORKERS"] = value
                start = threading.Event()
                def submit(i):
                    start.wait(1)
                    self.submit(str(i))
                callers = [threading.Thread(target=submit, args=(i,)) for i in range(4)]
                for t in callers: t.start()
                start.set()
                for t in callers:
                    t.join(2)
                    self.assertFalse(t.is_alive())
                self._wait_prefetch()
                self.assertEqual(len(plugin._PREFETCH_WORKERS), expected)

    def test_dead_worker_is_replaced(self):
        os.environ["MEMORY_CRYSTAL_PREFETCH_WORKERS"] = "1"
        self.addCleanup(os.environ.pop, "MEMORY_CRYSTAL_PREFETCH_WORKERS", None)
        plugin._prefetch_reset()
        class Die(BaseException):
            pass
        original = self.client.recall
        def recall(query, session, *args, **kwargs):
            if session == "dies":
                raise Die()
            return original(query, session, *args, **kwargs)
        self.client.recall = recall
        hook = threading.excepthook
        threading.excepthook = lambda args: None  # the dying worker's traceback is expected
        try:
            self.submit("dies")
            for worker in list(plugin._PREFETCH_WORKERS):
                worker.join(2)
            self.assertFalse(any(w.is_alive() for w in plugin._PREFETCH_WORKERS))
            self.submit("b")
            self._wait_prefetch()
        finally:
            threading.excepthook = hook
        self.assertTrue(plugin.SESSIONS["b"].last_recall_context)
        self.assertEqual([w.is_alive() for w in plugin._PREFETCH_WORKERS], [True])

    def test_failed_worker_start_is_not_kept(self):
        os.environ["MEMORY_CRYSTAL_PREFETCH_WORKERS"] = "2"
        self.addCleanup(os.environ.pop, "MEMORY_CRYSTAL_PREFETCH_WORKERS", None)
        plugin._prefetch_reset()
        real_start = threading.Thread.start
        started = []
        def start(thread):
            started.append(thread)
            if len(started) == 2:
                raise RuntimeError("can't start new thread")
            return real_start(thread)
        with patch.object(threading.Thread, "start", start):
            with self.assertRaises(RuntimeError):
                self.submit("a")
        self.assertTrue(all(w.is_alive() for w in plugin._PREFETCH_WORKERS))
        self.submit("a")
        self._wait_prefetch()
        self.assertEqual([w.is_alive() for w in plugin._PREFETCH_WORKERS], [True, True])
        self.assertTrue(plugin.SESSIONS["a"].last_recall_context)

    def test_existing_recall_update_survives_worker_start_failure(self):
        for running in (False, True):
            with self.subTest(running=running):
                plugin._prefetch_reset()
                state = plugin._session_state("fixture")
                old = ("test", self.client, "old", "old", {})
                new = ("test", self.client, "new", "new", {})
                job = {"state": state, "session_id": "fixture", "kind": "recall",
                       "request": old, "running": running}
                plugin._PREFETCH_JOBS[(id(state), "recall")] = job
                try:
                    with patch.object(threading.Thread, "start", side_effect=RuntimeError("start failed")):
                        with self.assertRaisesRegex(RuntimeError, "start failed"):
                            plugin._enqueue_prefetch("recall", "fixture", new)
                    self.assertEqual(job.get("pending" if running else "request"), new)
                    if running:
                        self.assertEqual(job["request"], old)
                    self.assertEqual(plugin._PREFETCH_WORKERS, [])
                finally:
                    plugin._PREFETCH_JOBS.pop((id(state), "recall"), None)

    def test_dead_worker_with_pending_is_replaced(self):
        os.environ["MEMORY_CRYSTAL_PREFETCH_WORKERS"] = "1"
        self.addCleanup(os.environ.pop, "MEMORY_CRYSTAL_PREFETCH_WORKERS", None)
        plugin._prefetch_reset()
        class Die(BaseException):
            pass
        entered, release = self.gate(), self.gate()
        original = self.client.recall
        seen = []
        def recall(query, session, *args, **kwargs):
            seen.append(query)
            if query == "q1":
                entered.set()
                release.wait(2)
                raise Die()
            return original(query, session, *args, **kwargs)
        self.client.recall = recall
        hook = threading.excepthook
        threading.excepthook = lambda args: None  # the dying worker's traceback is expected
        try:
            self.submit("a", "q1")
            self.assertTrue(entered.wait(1))
            self.submit("a", "q2")  # pending behind the running job
            release.set()
            for worker in list(plugin._PREFETCH_WORKERS):
                worker.join(2)
            self.assertFalse(any(w.is_alive() for w in plugin._PREFETCH_WORKERS))
            self.submit("a", "q3")  # only updates the requeued job, and must still restore the pool
            self._wait_prefetch()
        finally:
            threading.excepthook = hook
        self.assertEqual(seen, ["q1", "q3"])
        self.assertTrue(plugin.SESSIONS["a"].last_recall_context)
        self.assertEqual([w.is_alive() for w in plugin._PREFETCH_WORKERS], [True])

    def test_provider_warmup_records_start_failure(self):
        plugin._prefetch_reset()
        provider = plugin.MemoryCrystalProvider()
        provider.initialize("a")
        with patch.object(threading.Thread, "start", side_effect=RuntimeError("can't start new thread")):
            provider.queue_prefetch("project plan")  # must not raise into Hermes
        self.assertIn("can't start new thread", plugin.SESSIONS["a"].last_error)
        self.assertEqual(plugin._PREFETCH_WORKERS, [])
        self.assertEqual(plugin._PREFETCH_JOBS, {})

    def test_empty_session_id_refreshes_and_gets_wake(self):
        first = plugin._recall_context("", "project plan")
        self.assertNotIn("Welcome back", first)
        self._wait_prefetch()
        self.assertTrue(plugin.SESSIONS["default"].last_recall_context)
        expected = plugin._format_wake(self.client.wake("fixture", "test"))
        self.assertIn(expected, plugin._recall_context("", "project plan"))

    def test_wake_delivery(self):
        first = plugin._recall_context("a", "project plan")
        self.assertNotIn("Welcome back", first)
        self._wait_prefetch()
        self.assertFalse(plugin.SESSIONS["a"].wake_injected)
        expected = plugin._format_wake(self.client.wake("fixture", "test"))
        second = plugin._recall_context("a", "project plan")
        self.assertIn(expected, second)
        self.assertTrue(plugin.SESSIONS["a"].wake_injected)
        self.assertNotIn(expected, plugin._recall_context("a", "project plan"))

    def test_wake_isolation(self):
        self.client.wake = lambda session, *a, **kw: {"briefing": f"briefing for {session}"}
        for session in ("a", "b"): plugin._prefetch_wake(session, "test", self.client)
        self._wait_prefetch()
        b = plugin._recall_context("b", "thanks")
        a = plugin._recall_context("a", "thanks")
        self.assertIn("briefing for b", b)
        self.assertNotIn("briefing for a", b)
        self.assertIn("briefing for a", a)
        self.assertNotIn("briefing for b", a)
        self.assertNotIn("briefing for a", plugin._recall_context("a", "thanks"))

    def test_wake_failure_retry(self):
        calls = []
        def wake(*args, **kwargs):
            calls.append(args)
            raise RuntimeError("wake failed")
        self.client.wake = wake
        for query in ("first project question", "next project question"):
            plugin._recall_context("a", query)
            self._wait_prefetch()
            self.assertFalse(plugin.SESSIONS["a"].wake_injected)
            self.assertIsNone(plugin.SESSIONS["a"].prefetched_wake)
        self.assertEqual(len(calls), 2)
        self.assertIn("wake failed", plugin.SESSIONS["a"].last_error)
        self.client.wake = lambda *a, **kw: {"error": "wake rejected"}
        plugin._prefetch_wake("a", "test", self.client)
        self._wait_prefetch()
        self.assertIsNone(plugin.SESSIONS["a"].prefetched_wake)

    def early_delivery(self, case):
        plugin._prefetch_wake("a", "test", self.client)
        self._wait_prefetch()
        state = plugin.SESSIONS["a"]
        query = "thanks" if case == "trivial" else "project plan"
        if case == "cache":
            channel = plugin._channel(None)
            state.recall_cache[hashlib.sha256(f"{channel}\n{query}".encode()).hexdigest()] = "cached"
        if case == "circuit":
            state.circuit_failures = 100
            state.circuit_opened_at = time.time()
        self.assertIn("Welcome back", plugin._recall_context("a", query))
        self.assertNotIn("Welcome back", plugin._recall_context("a", query))

    def test_wake_trivial(self): self.early_delivery("trivial")
    def test_wake_cache(self): self.early_delivery("cache")
    def test_wake_circuit(self): self.early_delivery("circuit")

    def test_provider_warmup(self):
        provider = plugin.MemoryCrystalProvider()
        provider.initialize("a")
        provider.queue_prefetch("project plan")
        self._wait_prefetch()
        state = plugin.SESSIONS["a"]
        self.assertFalse(state.wake_injected)
        self.assertFalse(state.tools_injected)
        with patch.object(plugin.threading, "Thread", side_effect=AssertionError("unexpected thread")):
            provider.queue_prefetch("project plan")
        self.assertFalse(state.wake_injected)
        self.assertFalse(state.tools_injected)
        self.assertIn("Welcome back", provider.prefetch("project plan"))
        self.assertNotIn("Welcome back", provider.prefetch("project plan"))

    def test_reset_running(self):
        entered, release = self.block_client("a")
        try:
            self.submit("a")
            self.assertTrue(entered.wait(1))
            old = plugin.SESSIONS["a"]
            self.submit("a", "pending")
            plugin._clear_session("a", "test")
        finally: release.set()
        self._wait_prefetch()
        self.assertNotIn("a", plugin.SESSIONS)
        self.assertEqual(old.last_recall_context, "")
        self.assertEqual(len(self.client.calls), 1)

    def test_reset_queued(self):
        os.environ["MEMORY_CRYSTAL_PREFETCH_WORKERS"] = "1"
        entered, release = self.block_client("b")
        try:
            self.submit("b")
            self.assertTrue(entered.wait(1))
            self.submit("a")
            plugin._clear_session("a", "test")
        finally: release.set()
        self._wait_prefetch()
        self.assertNotIn("a", plugin.SESSIONS)
        self.assertFalse(any(c[2] == "a" for c in self.client.calls if c[0] == "recall"))

    def test_static_global_guard(self):
        self.assertEqual(global_assignment_offenders(PLUGIN_PATH.read_text()), [])
        fixture = "_PREFETCH_WAKE_RESULT = None\ndef outer():\n global _PREFETCH_WAKE_RESULT\n def _refresh_wake():\n  _PREFETCH_WAKE_RESULT = {}\n"
        self.assertEqual(global_assignment_offenders(fixture), ["_refresh_wake:_PREFETCH_WAKE_RESULT"])
        self.assertEqual(global_assignment_offenders("VALUE = 0\ndef f():\n VALUE += 1\n"), ["f:VALUE"])

    def test_static_global_guard_binding_mutants(self):
        forms = {
            "assign": "VALUE = 1",
            "annotated": "VALUE: int = 1",
            "augmented": "VALUE += 1",
            "walrus": "if (VALUE := 1): pass",
            "for": "for VALUE in []: pass",
            "async_for": "async for VALUE in stream: pass",
            "with": "with context() as VALUE: pass",
            "async_with": "async with context() as VALUE: pass",
            "import": "import module as VALUE",
            "import_plain": "import VALUE.child",
            "from_import": "from module import name as VALUE",
            "from_import_plain": "from module import VALUE",
            "except": "try: pass\nexcept Exception as VALUE: pass",
            "comprehension_walrus": "items = [(VALUE := item) for item in []]",
        }
        for form, binding in forms.items():
            with self.subTest(form=form):
                body = "\n".join("    " + line for line in binding.splitlines())
                source = "VALUE = 0\nasync def f():\n" + body + "\n"
                self.assertEqual(global_assignment_offenders(source), ["f:VALUE"])
                control = source.replace("async def f():\n", "async def f():\n    global VALUE\n")
                self.assertEqual(global_assignment_offenders(control), [])
        for block in (
            "if True:\n VALUE = 0",
            "try:\n VALUE = 0\nexcept Exception: pass",
            "try: pass\nexcept Exception:\n VALUE = 0",
            "try: pass\nexcept Exception: pass\nelse:\n VALUE = 0",
            "try: pass\nfinally:\n VALUE = 0",
            "with context():\n VALUE = 0",
        ):
            with self.subTest(block=block):
                self.assertEqual(global_assignment_offenders(block + "\ndef f():\n VALUE = 1\n"), ["f:VALUE"])
        for expression in ("[VALUE for VALUE in []]", "{VALUE for VALUE in []}",
                           "{VALUE: VALUE for VALUE in []}", "(VALUE for VALUE in [])"):
            self.assertEqual(global_assignment_offenders("VALUE = 0\ndef f():\n items = " + expression), [])

    def test_downstream_contract(self):
        source = PLUGIN_PATH.read_text()
        self.assertEqual(source.count('CAPTURE_LAST_FLUSH_RESULT = ""'), 1)
        self.assertEqual(source.count(CIRCUIT_CONTRACT), 1)
        start = source.index("def _circuit_open(")
        end = source.index("\ndef ", source.index("def _record_backend_result(", start))
        self.assertEqual(source[start:end], CIRCUIT_CONTRACT)
        for name in ("_client", "_extract_memories", "_clean_text", "_trivial_prompt", "_env_float"):
            self.assertTrue(callable(getattr(plugin, name)))
        self.assertTrue(hasattr(plugin, "MemoryCrystalClient"))

    def test_plugin_version(self):
        self.assertIn('version: "0.10.3"', PLUGIN_PATH.with_name("plugin.yaml").read_text())
        self.assertIn('memory-crystal-hermes-plugin/0.10.3', PLUGIN_PATH.read_text())


if __name__ == "__main__":
    unittest.main()
