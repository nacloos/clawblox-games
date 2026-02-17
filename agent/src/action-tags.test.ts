import test from "node:test";
import assert from "node:assert/strict";
import { extractActionPayloads, parseActionPayloads } from "./action-tags.js";

test("extractActionPayloads parses valid action tags", () => {
  const text = [
    "Before",
    "<action>{\"type\":\"Vote\",\"data\":{\"target\":\"yasmin\"}}</action>",
    "Between",
    "<action>{\"type\":\"UseIdol\",\"data\":{\"target\":\"guy\"}}</action>",
  ].join("\n");

  const actions = extractActionPayloads(text);
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[0], { type: "Vote", data: { target: "yasmin" } });
  assert.deepEqual(actions[1], { type: "UseIdol", data: { target: "guy" } });
});

test("extractActionPayloads skips malformed or missing type payloads", () => {
  const text = [
    "<action>not json</action>",
    "<action>{\"data\":{\"target\":\"x\"}}</action>",
    "<action>{\"type\":\"RevealVotes\"}</action>",
  ].join("\n");

  const actions = extractActionPayloads(text);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], { type: "RevealVotes", data: {} });
});

test("parseActionPayloads reports parse errors", () => {
  const text = [
    "<action>not json</action>",
    "<action>{\"data\":{\"target\":\"x\"}}</action>",
    "<action></action>",
  ].join("\n");
  const parsed = parseActionPayloads(text);
  assert.equal(parsed.actions.length, 0);
  assert.equal(parsed.errors.length, 3);
  assert.match(parsed.errors[0].reason, /invalid_json:/);
  assert.equal(parsed.errors[1].reason, "missing_type");
  assert.equal(parsed.errors[2].reason, "empty_payload");
});
