import assert from "node:assert/strict";
import { Agent } from "/home/nacloos/Code/pi-mono/packages/agent/dist/index.js";
import { EventStream } from "/home/nacloos/Code/pi-mono/packages/ai/dist/index.js";

class MockAssistantStream extends EventStream {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createModel() {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistantMessage(text, stopReason = "stop") {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function extractSpeakSegments(text) {
	const out = [];
	const re = /<s>([\s\S]*?)<\/s>/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		const seg = m[1].trim();
		if (seg) out.push(seg);
	}
	return out;
}

const seenContexts = [];
let callIndex = 0;

const streamFn = (_model, llmContext, _options) => {
	seenContexts.push(llmContext);
	const stream = new MockAssistantStream();
	queueMicrotask(() => {
		stream.push({
			type: "done",
			reason: "stop",
			message: createAssistantMessage(
				callIndex === 0
					? "ready"
					: "not for tts <s>Enemy left. Rotating.</s> keep focus",
			),
		});
		callIndex += 1;
	});
	return stream;
};

const speechAgent = new Agent({
	initialState: {
		systemPrompt: "You are speech agent.",
		model: createModel(),
		thinkingLevel: "off",
		tools: [],
	},
	convertToLlm: (messages) =>
		messages.filter(
			(m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
		),
	streamFn,
});

speechAgent.setSteeringMode("all");

await speechAgent.prompt("hello");

const toolCallId = `bridge_${Date.now()}`;
speechAgent.steer({
	role: "assistant",
	content: [{ type: "toolCall", id: toolCallId, name: "act_in_world", arguments: { action: { type: "Move", data: { x: 1, z: 0 } } } }],
	api: "openai-responses",
	provider: "openai",
	model: "mock",
	usage: createUsage(),
	stopReason: "toolUse",
	timestamp: Date.now(),
});
speechAgent.steer({
	role: "toolResult",
	toolCallId,
	toolName: "act_in_world",
	content: [{ type: "text", text: JSON.stringify({ ok: true, obs: { hp: 95 } }) }],
	details: {},
	isError: false,
	timestamp: Date.now(),
});

await speechAgent.continue();

assert.equal(seenContexts.length, 2, "Expected two LLM calls");
const secondCtx = seenContexts[1];

const injectedToolCall = secondCtx.messages.find(
	(m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((c) => c.type === "toolCall" && c.id === toolCallId),
);
const injectedToolResult = secondCtx.messages.find(
	(m) => m.role === "toolResult" && m.toolCallId === toolCallId,
);

assert.ok(injectedToolCall, "Missing injected assistant toolCall in second context");
assert.ok(injectedToolResult, "Missing injected toolResult in second context");

const assistantTexts = speechAgent.state.messages
	.filter((m) => m.role === "assistant")
	.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
	.filter((c) => c.type === "text")
	.map((c) => c.text);

assert.equal(assistantTexts.length, 2, "Expected two assistant text messages");
assert.deepEqual(extractSpeakSegments(assistantTexts[0]), [], "First response should have no speak tag");
assert.deepEqual(
	extractSpeakSegments(assistantTexts[1]),
	["Enemy left. Rotating."],
	"Second response should expose only <s>...</s> as spoken text",
);

console.log("PASS: steer toolCall+toolResult appears in next context; <s>...</s> extraction yields only spoken segments.");
