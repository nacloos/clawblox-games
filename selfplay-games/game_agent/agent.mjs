import { Agent } from "/home/nacloos/Code/pi-mono/packages/agent/dist/index.js";
import { getModel } from "/home/nacloos/Code/pi-mono/packages/ai/dist/index.js";
import { createCodingTools } from "/home/nacloos/Code/pi-mono/packages/coding-agent/dist/index.js";
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

function loadDotEnvIntoProcessEnv(envPath) {
	if (!existsSync(envPath)) return;
	const content = readFileSync(envPath, "utf8");
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		if (!key || process.env[key] !== undefined) continue;
		let value = line.slice(eq + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		process.env[key] = value;
	}
}

function loadDotEnvFromCwdAndParents(maxLevels = 4) {
	let dir = process.cwd();
	for (let i = 0; i < maxLevels; i++) {
		loadDotEnvIntoProcessEnv(path.join(dir, ".env"));
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
}

function extractSpeakSegments(text) {
	const out = [];
	const re = /<(?:speak|s)>([\s\S]*?)<\/(?:speak|s)>/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		const segment = m[1].trim();
		if (segment) out.push(segment);
	}
	return out;
}

class ElevenLabsRealtimePlayer {
	constructor({ apiKey, voiceId, modelId = "eleven_flash_v2_5", outputFormat = "pcm_16000" }) {
		this.apiKey = apiKey;
		this.voiceId = voiceId;
		this.modelId = modelId;
		this.outputFormat = outputFormat;
		this.ws = null;
		this.ffplay = null;
		this.keepaliveTimer = null;
		this.queue = [];
		this.processing = false;
		this.msgQueue = [];
		this.msgWaiter = null;
		this.closed = false;
	}

	startFfplay() {
		this.ffplay = spawn(
			"ffplay",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-autoexit",
				"-nodisp",
				"-probesize",
				"32",
				"-analyzeduration",
				"0",
				"-fflags",
				"nobuffer",
				"-flags",
				"low_delay",
				"-f",
				"s16le",
				"-ar",
				"16000",
				"-ac",
				"1",
				"-i",
				"pipe:0",
			],
			{ stdio: ["pipe", "ignore", "ignore"] },
		);
		this.ffplay.once("error", (err) => {
			output.write(`[audio] ffplay unavailable: ${err instanceof Error ? err.message : String(err)}\n`);
		});
	}

	cleanupConnection() {
		if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
		this.keepaliveTimer = null;
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			try {
				this.ws.close();
			} catch {}
		}
		this.ws = null;
		if (this.ffplay) {
			try {
				this.ffplay.kill("SIGKILL");
			} catch {}
		}
		this.ffplay = null;
		this.msgQueue = [];
		this.msgWaiter = null;
	}

	async connect() {
		this.cleanupConnection();
		this.startFfplay();
		const wsUrl =
			`wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream-input` +
			`?model_id=${encodeURIComponent(this.modelId)}&output_format=${encodeURIComponent(this.outputFormat)}`;
		this.ws = new WebSocket(wsUrl);
		const ws = this.ws;

		await new Promise((resolve, reject) => {
			const onOpen = () => {
				cleanup();
				resolve();
			};
			const onError = (err) => {
				cleanup();
				reject(err instanceof Error ? err : new Error("WebSocket connection error"));
			};
			const cleanup = () => {
				ws.removeEventListener("open", onOpen);
				ws.removeEventListener("error", onError);
			};
			ws.addEventListener("open", onOpen);
			ws.addEventListener("error", onError);
		});

		ws.addEventListener("message", (event) => {
			let msg;
			try {
				msg = JSON.parse(String(event.data));
			} catch {
				return;
			}
			this.msgQueue.push(msg);
			if (this.msgWaiter) {
				const waiter = this.msgWaiter;
				this.msgWaiter = null;
				waiter();
			}
		});
		ws.addEventListener("close", () => {
			if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
			this.keepaliveTimer = null;
		});

		ws.send(
			JSON.stringify({
				text: " ",
				voice_settings: { stability: 0.45, similarity_boost: 0.8, use_speaker_boost: true },
				generation_config: { chunk_length_schedule: [120, 160, 250, 290] },
				xi_api_key: this.apiKey,
			}),
		);

		this.keepaliveTimer = setInterval(() => {
			if (this.ws && this.ws.readyState === WebSocket.OPEN) {
				this.ws.send(JSON.stringify({ text: " " }));
			}
		}, 15000);
	}

	async ensureConnected() {
		if (this.closed) return;
		if (this.ws && this.ws.readyState === WebSocket.OPEN && this.ffplay?.stdin?.writable) return;
		await this.connect();
	}

	nextMessage(timeoutMs = 2500) {
		if (this.msgQueue.length > 0) return Promise.resolve(this.msgQueue.shift());
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (this.msgWaiter) this.msgWaiter = null;
				resolve(null);
			}, timeoutMs);
			this.msgWaiter = () => {
				clearTimeout(timer);
				resolve(this.msgQueue.shift() ?? null);
			};
		});
	}

	async speakOne(text) {
		await this.ensureConnected();
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		this.msgQueue = [];
		this.ws.send(JSON.stringify({ text, flush: true }));
		while (!this.closed) {
			const msg = await this.nextMessage(2500);
			if (!msg) break;
			if (msg.audio && this.ffplay?.stdin?.writable) {
				try {
					this.ffplay.stdin.write(Buffer.from(msg.audio, "base64"));
				} catch {
					break;
				}
			}
			if (msg.isFinal === true) break;
		}
	}

	async processQueue() {
		if (this.processing || this.closed) return;
		this.processing = true;
		try {
			while (this.queue.length > 0 && !this.closed) {
				const text = this.queue.shift();
				if (!text) continue;
				await this.speakOne(text);
			}
		} finally {
			this.processing = false;
		}
	}

	enqueue(text) {
		if (this.closed) return;
		const cleaned = text.trim();
		if (!cleaned) return;
		this.queue.push(cleaned);
		this.processQueue().catch((err) => {
			output.write(`[audio] playback error: ${err instanceof Error ? err.message : String(err)}\n`);
		});
	}

	async start() {
		await this.ensureConnected();
	}

	close() {
		this.closed = true;
		this.queue = [];
		this.cleanupConnection();
	}
}

function loadCodexAccessToken(scriptDir) {
	const candidates = [
		path.join(process.cwd(), "auth.json"),
		path.join(scriptDir, "auth.json"),
	];
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		try {
			const auth = JSON.parse(readFileSync(p, "utf8"));
			const creds = auth?.["openai-codex"];
			if (creds && typeof creds.access === "string" && creds.access.length > 0) {
				return creds.access;
			}
		} catch {
			// Ignore malformed auth file and continue.
		}
	}
	return undefined;
}

function getLastAssistantText(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const t = (m.content || [])
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();
		if (t) return t;
	}
	return "";
}

loadDotEnvFromCwdAndParents();

const scriptPath = new URL(import.meta.url).pathname;
const scriptDir = path.dirname(scriptPath);
const scriptName = path.basename(scriptPath, path.extname(scriptPath));
const resultsDir = path.join(scriptDir, "results", scriptName);
mkdirSync(resultsDir, { recursive: true });

const speechConversationPath = path.join(resultsDir, "speech_conversation.json");
const actionConversationPath = path.join(resultsDir, "action_conversation.json");
const speechSystemPromptPath = path.join(resultsDir, "system-prompt-speech.md");
const actionSystemPromptPath = path.join(resultsDir, "system-prompt-action.md");

const agentDir = path.join(scriptDir, "workspace", "agent");
const contextFiles = ["SOUL.md", "IDENTITY.md", "SEMANTIC_MEMORY.md", "EPISODIC_MEMORY.md"];
mkdirSync(agentDir, { recursive: true });
for (const file of contextFiles) {
	const dest = path.join(agentDir, file);
	if (!existsSync(dest)) {
		const templatePath = path.join(scriptDir, "templates", "agent", file);
		const template = existsSync(templatePath) ? readFileSync(templatePath, "utf8") : "";
		writeFileSync(dest, template);
	}
}

function loadContextFile(name) {
	return readFileSync(path.join(agentDir, name), "utf8").trim();
}

function buildActionSystemPrompt() {
	const base = process.env.PI_ACTION_SYSTEM_PROMPT || process.env.PI_SYSTEM_PROMPT || "";
	const lines = [base];
	lines.push(
		"",
		"# Project Context",
		"",
		"The following files are loaded from your workspace. They are yours to evolve.",
		"If SOUL.md is present, embody its persona and tone.",
		"",
	);
	for (const file of contextFiles) {
		const filePath = path.join(agentDir, file);
		const content = loadContextFile(file);
		if (content) lines.push("---", "", `**${file}** (${filePath})`, "", content, "");
	}
	lines.push(
		"## Workspace",
		"",
		`Your workspace is ${agentDir}. Only work inside this directory.`,
		"Use tools to play/observe quickly and report concise status.",
		"When asked to observe, run /observe via bash and summarize the result briefly.",
	);
	return lines.join("\n");
}

const speechBase = process.env.PI_SPEECH_SYSTEM_PROMPT || process.env.PI_SYSTEM_PROMPT || "You are a speech agent in a game world.";
const speechSystemPrompt = [
	speechBase,
	"",
	"You receive world updates as assistant tool calls named act_in_world with matching tool results.",
	"Treat those as your own recent actions and observations.",
	"If you don't observe anything important, say nothing.",
	"Use <speak>...</speak> for text that should be spoken out loud. Take into account speaking time.",
].join("\n");
const actionSystemPrompt = buildActionSystemPrompt();

writeFileSync(speechSystemPromptPath, speechSystemPrompt);
writeFileSync(actionSystemPromptPath, actionSystemPrompt);

const codexAccessToken = loadCodexAccessToken(scriptDir);
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
const modelProvider = process.env.PI_PROVIDER || (codexAccessToken ? "openai-codex" : "anthropic");
const modelName = process.env.PI_MODEL || (modelProvider === "openai-codex" ? "gpt-5.3-codex" : "claude-opus-4-6");
const model = getModel(modelProvider, modelName);

if (modelProvider === "openai-codex" && !codexAccessToken) {
	console.error("Missing Codex OAuth token. Run: npx @mariozechner/pi-ai login openai-codex");
	process.exit(1);
}
if (modelProvider === "anthropic" && !anthropicApiKey) {
	console.error("Missing ANTHROPIC_API_KEY (set env var or add it to .env)");
	process.exit(1);
}

const speechAgent = new Agent({
	initialState: {
		systemPrompt: speechSystemPrompt,
		model,
		thinkingLevel: "off",
		tools: [],
	},
	getApiKey: (provider) => {
		if (provider === "openai-codex") return codexAccessToken;
		if (provider === "anthropic") return anthropicApiKey;
		return undefined;
	},
});
speechAgent.setSteeringMode("all");

const actionAgent = new Agent({
	initialState: {
		systemPrompt: actionSystemPrompt,
		model,
		thinkingLevel: "off",
		tools: createCodingTools(process.cwd()),
	},
	getApiKey: (provider) => {
		if (provider === "openai-codex") return codexAccessToken;
		if (provider === "anthropic") return anthropicApiKey;
		return undefined;
	},
});

let speechBusy = false;
let actionBusy = false;
let isClosing = false;
let speechSawDelta = false;
let speechPrefixPrinted = false;

const observeIntervalMs = Number(process.env.OBSERVE_MS || "3000");
const observePrompt = process.env.OBSERVE_PROMPT || "Run /observe using bash. Return a concise plain-text summary.";
let observeTimer = null;
let observeEnabled = true;
let observeSeq = 0;
let lastObservedText = "";

const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY || "";
const elevenLabsVoiceId =
	process.env.AGENT_A_VOICE_ID || process.env.AGENT_VOICE_ID || process.env.ELEVENLABS_VOICE_ID || "";
const elevenLabsModelId = process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5";
const elevenLabsOutputFormat = process.env.ELEVENLABS_OUTPUT_FORMAT || "pcm_16000";
const audioPlayer =
	elevenLabsApiKey && elevenLabsVoiceId
		? new ElevenLabsRealtimePlayer({
				apiKey: elevenLabsApiKey,
				voiceId: elevenLabsVoiceId,
				modelId: elevenLabsModelId,
				outputFormat: elevenLabsOutputFormat,
			})
		: null;

function persistSpeechConversation() {
	writeFileSync(speechConversationPath, JSON.stringify(speechAgent.state.messages, null, 2));
}

function persistActionConversation() {
	writeFileSync(actionConversationPath, JSON.stringify(actionAgent.state.messages, null, 2));
}

function printPrompt(rl) {
	if (!isClosing && !speechBusy) rl.prompt();
}

function injectObservationToSpeech(observeText) {
	const text = observeText.trim();
	if (!text) return;
	if (text === lastObservedText) return;
	lastObservedText = text;
	observeSeq += 1;
	const toolCallId = `observe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const ts = Date.now();

	speechAgent.steer({
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "act_in_world", arguments: { action: { type: "Observe", data: { step: observeSeq } } } }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: ts,
	});

	speechAgent.steer({
		role: "toolResult",
		toolCallId,
		toolName: "act_in_world",
		content: [{ type: "text", text: JSON.stringify({ ok: true, observation: { ts, observe_text: text } }) }],
		details: {},
		isError: false,
		timestamp: ts,
	});
}

async function runSpeechContinue(rl, options = {}) {
	speechBusy = true;
	try {
		await speechAgent.continue();
	} catch (error) {
		console.error("Speech continue error:", error instanceof Error ? error.message : error);
	} finally {
		speechBusy = false;
		if (!options.silentPrompt) printPrompt(rl);
	}
}

async function runObserveOnce(rl, { forceSpeak = false } = {}) {
	if (isClosing || !observeEnabled || actionBusy) return;
	actionBusy = true;
	try {
		await actionAgent.prompt(observePrompt);
		const observedText = getLastAssistantText(actionAgent.state.messages);
		injectObservationToSpeech(observedText);
		if ((forceSpeak || speechAgent.state.messages.length > 0) && !speechBusy) {
			await runSpeechContinue(rl, { silentPrompt: true });
		}
	} catch (error) {
		output.write(`[observe] error: ${error instanceof Error ? error.message : String(error)}\n`);
	} finally {
		actionBusy = false;
	}
}

function startObserveLoop(rl) {
	if (!Number.isFinite(observeIntervalMs) || observeIntervalMs < 250) return;
	if (observeTimer) clearInterval(observeTimer);
	observeTimer = setInterval(() => {
		void runObserveOnce(rl);
	}, observeIntervalMs);
}

function stopObserveLoop() {
	if (observeTimer) clearInterval(observeTimer);
	observeTimer = null;
}

speechAgent.subscribe((event) => {
	persistSpeechConversation();

	if (event.type === "message_start" && event.message.role === "assistant") {
		speechSawDelta = false;
		speechPrefixPrinted = false;
		return;
	}

	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		speechSawDelta = true;
		if (!speechPrefixPrinted) {
			output.write("speech> ");
			speechPrefixPrinted = true;
		}
		output.write(event.assistantMessageEvent.delta);
		return;
	}

	if (event.type === "message_end" && event.message.role === "assistant") {
		let fullText = "";
		const errorMessage = event.message.errorMessage;
		const hasText = event.message.content.some((c) => c.type === "text" && c.text.trim().length > 0);
		if (!speechSawDelta) {
			fullText = event.message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
			if (hasText) {
				output.write(`speech> ${fullText}\n`);
				speechPrefixPrinted = true;
			}
		} else {
			fullText = event.message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
			output.write("\n");
		}
		if (errorMessage) output.write(`[error] ${errorMessage}\n`);

		speechSawDelta = false;
		speechPrefixPrinted = false;

		const spoken = extractSpeakSegments(fullText);
		if (spoken.length > 0) {
			for (const seg of spoken) {
				output.write(`[speak] ${seg}\n`);
				audioPlayer?.enqueue(seg);
			}
		}
	}
});

actionAgent.subscribe((event) => {
	persistActionConversation();
	if (process.env.ACTION_DEBUG !== "1") return;
	if (event.type === "message_end" && event.message.role === "assistant") {
		const txt = event.message.content.filter((c) => c.type === "text").map((c) => c.text).join("").trim();
		if (txt) output.write(`[action] ${txt}\n`);
	}
});

const rl = createInterface({ input, output, terminal: true });
rl.setPrompt("you> ");
output.write(`Dual-agent ready with model \"${modelName}\" (${modelProvider}).\n`);
output.write("Commands: /reset, /quit, /observe on|off|status|once\n");
if (audioPlayer) {
	audioPlayer.start()
		.then(() => output.write(`ElevenLabs audio enabled (voice=${elevenLabsVoiceId}).\n`))
		.catch((err) => output.write(`[audio] failed to start: ${err instanceof Error ? err.message : String(err)}\n`));
} else {
	output.write("ElevenLabs audio disabled (set ELEVENLABS_API_KEY + AGENT_A_VOICE_ID/AGENT_VOICE_ID).\n");
}
if (observeEnabled) {
	startObserveLoop(rl);
	output.write(`Observe loop started (${observeIntervalMs}ms).\n`);
}
printPrompt(rl);

rl.on("line", (rawLine) => {
	const line = rawLine.trim();
	if (!line) {
		printPrompt(rl);
		return;
	}
	if (line === "/quit" || line === "/exit") {
		isClosing = true;
		rl.close();
		return;
	}
	if (line === "/reset") {
		if (speechBusy) speechAgent.abort();
		if (actionBusy) actionAgent.abort();
		speechAgent.reset();
		actionAgent.reset();
		speechAgent.setSystemPrompt(speechSystemPrompt);
		actionAgent.setSystemPrompt(buildActionSystemPrompt());
		lastObservedText = "";
		output.write("speech> Context cleared.\n");
		printPrompt(rl);
		return;
	}
	if (line === "/observe status") {
		output.write(`speech> Observe is ${observeEnabled ? "on" : "off"} (${observeIntervalMs}ms).\n`);
		printPrompt(rl);
		return;
	}
	if (line === "/observe on") {
		observeEnabled = true;
		startObserveLoop(rl);
		output.write("speech> Observe loop on.\n");
		printPrompt(rl);
		return;
	}
	if (line === "/observe off") {
		observeEnabled = false;
		stopObserveLoop();
		output.write("speech> Observe loop off.\n");
		printPrompt(rl);
		return;
	}
	if (line === "/observe once") {
		void runObserveOnce(rl, { forceSpeak: true });
		printPrompt(rl);
		return;
	}

	if (speechBusy) {
		speechAgent.steer({ role: "user", content: [{ type: "text", text: line }], timestamp: Date.now() });
		output.write("speech> Queued steer message.\n");
		printPrompt(rl);
		return;
	}

	const userMessage = { role: "user", content: [{ type: "text", text: line }], timestamp: Date.now() };
	if (speechAgent.state.messages.length === 0) {
		speechAgent.appendMessage(userMessage);
	} else {
		speechAgent.steer(userMessage);
	}
	void runSpeechContinue(rl);
});

rl.on("SIGINT", () => {
	if (speechBusy || actionBusy) {
		speechAgent.abort();
		actionAgent.abort();
		output.write("\nspeech> Aborted.\n");
		speechBusy = false;
		actionBusy = false;
		printPrompt(rl);
		return;
	}
	isClosing = true;
	rl.close();
});

rl.on("close", () => {
	stopObserveLoop();
	audioPlayer?.close();
	persistSpeechConversation();
	persistActionConversation();
	process.exit(0);
});
