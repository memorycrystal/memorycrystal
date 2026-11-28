import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalTools } from "./crystal-local-tools.js";

function toolText(result) {
  return result.content.map((item) => item.text || "").join("\n");
}

test("local tool errors redact bearer tokens and keyed secrets", async () => {
  const store = {
    async getContextItems() {
      throw new Error(
        "store failed Bearer local-secret-token-12345 apiKey: local-api-key-secret-12345, url?refresh_token=refresh-secret-12345"
      );
    },
  };
  const [grep] = createLocalTools(store);

  const result = await grep.execute("call-1", { query: "launch" }, null, null, {
    sessionKey: "session-1",
  });
  const text = toolText(result);

  assert.equal(result.isError, true);
  assert.match(text, /Bearer \[REDACTED\]/);
  assert.match(text, /apiKey: \[REDACTED\]/);
  assert.match(text, /refresh_token=\[REDACTED\]/);
  assert.doesNotMatch(text, /local-secret-token-12345/);
  assert.doesNotMatch(text, /local-api-key-secret-12345/);
  assert.doesNotMatch(text, /refresh-secret-12345/);
});
