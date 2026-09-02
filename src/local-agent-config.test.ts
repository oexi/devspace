import assert from "node:assert/strict";
import {
  isSubagentProviderEnabled,
  subagentProviderConfig,
  subagentsConfigSchema,
} from "./local-agent-config.js";

const config = subagentsConfigSchema.parse({
  enabled: true,
  providers: [
    { id: "codex", enabled: true, model: " gpt-5.4 ", effort: " high ", network: "enabled" },
    { id: "claude", enabled: false, model: "sonnet" },
  ],
});
assert.deepEqual(config, {
  enabled: true,
  providers: [
    { id: "codex", enabled: true, model: "gpt-5.4", effort: "high", network: "enabled" },
    { id: "claude", enabled: false, model: "sonnet" },
  ],
});
assert.equal(isSubagentProviderEnabled(config, "codex"), true);
assert.equal(isSubagentProviderEnabled(config, "claude"), false);
assert.equal(isSubagentProviderEnabled(config, "pi"), false);
assert.equal(subagentProviderConfig(config, "codex")?.model, "gpt-5.4");
assert.equal(subagentProviderConfig(config, "codex")?.network, "enabled");

assert.throws(
  () => subagentsConfigSchema.parse({
    enabled: true,
    providers: [{ id: "codex", enabled: true }, { id: "codex", enabled: false }],
  }),
  /Duplicate subagent provider: codex/,
);
assert.throws(
  () => subagentsConfigSchema.parse({
    enabled: true,
    providers: [{ id: "unknown", enabled: true }],
  }),
  /Invalid option/,
);
assert.throws(
  () => subagentsConfigSchema.parse({
    enabled: true,
    providers: [{ id: "codex", enabled: true, effort: "  " }],
  }),
  /Too small/,
);
assert.throws(
  () => subagentsConfigSchema.parse({
    enabled: true,
    providers: [{ id: "codex", enabled: true, network: "sometimes" }],
  }),
  /Invalid option/,
);
assert.throws(
  () => subagentsConfigSchema.parse({
    enabled: true,
    providers: [{ id: "claude", enabled: true, network: "enabled" }],
  }),
  /currently supported only for the codex provider/,
);
