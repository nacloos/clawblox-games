import { Agent } from "/home/nacloos/Code/pi-mono/packages/agent/dist/index.js";
import { getModel } from "/home/nacloos/Code/pi-mono/packages/ai/dist/index.js";
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

loadDotEnvFromCwdAndParents();

const scriptPath = new URL(import.meta.url).pathname;
const scriptDir = path.dirname(scriptPath);
const scriptName = path.basename(scriptPath, path.extname(scriptPath));
const resultsDir = path.join(scriptDir, "results", scriptName);
mkdirSync(resultsDir, { recursive: true });
const conversationPath = path.join(resultsDir, "conversation.json");
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

const baseSystemPrompt = process.env.PI_SYSTEM_PROMPT || "You are a speech agent in a game world.";
const systemPrompt = [
	baseSystemPrompt,
	"",
	"You receive world updates as assistant tool calls named act_in_world with matching tool results.",
	"Treat those as your own recent actions and observations.",
	"If you don't observe anything important, say nothing.",
	"Use <speak>...</speak> for text that should be spoken out loud.",
].join("\n");

const agent = new Agent({
	initialState: {
		systemPrompt,
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
agent.setSteeringMode("all");

let isBusy = false;
let isClosing = false;
let assistantSawDelta = false;
let assistantPrefixPrinted = false;
let autoInjectTimer = null;
let autoInjectIntervalMs = 0;
let autoInjectTemplate = null;
let autoInjectTick = 0;
const defaultAutoInjectMs = Number(process.env.AUTOINJECT_MS || "2000");
const unexpectedEventDelayMs = Number(process.env.UNEXPECTED_EVENT_MS || "10000");
let unexpectedEventTimer = null;
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

function persistConversation() {
	writeFileSync(conversationPath, JSON.stringify(agent.state.messages, null, 2));
}

function printPrompt(rl) {
	if (!isClosing && !isBusy) rl.prompt();
}

async function runContinue(rl, options = {}) {
	isBusy = true;
	try {
		await agent.continue();
	} catch (error) {
		console.error("Continue error:", error instanceof Error ? error.message : error);
	} finally {
		isBusy = false;
		if (!options.silentPrompt) printPrompt(rl);
	}
}

function injectActionEvent(payload) {
	const toolCallId = `bridge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const action = payload?.action ?? {};
	const observation = payload?.observation ?? payload?.obs ?? {};

	agent.steer({
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "act_in_world", arguments: { action } }],
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
		timestamp: Date.now(),
	});

	agent.steer({
		role: "toolResult",
		toolCallId,
		toolName: "act_in_world",
		content: [{ type: "text", text: JSON.stringify({ ok: true, observation }) }],
		details: {},
		isError: false,
		timestamp: Date.now(),
	});
}

function buildAutoInjectPayload() {
	autoInjectTick += 1;
	if (autoInjectTemplate) {
		const cloned = JSON.parse(JSON.stringify(autoInjectTemplate));
		if (!cloned.observation && !cloned.obs) cloned.observation = {};
		const obs = cloned.observation ?? cloned.obs;
		obs.auto_tick = autoInjectTick;
		obs.auto_ts = Date.now();
		return cloned;
	}
	const t = autoInjectTick;
	const angle = t * 0.35;
	const moveX = Number(Math.cos(angle).toFixed(3));
	const moveZ = Number(Math.sin(angle).toFixed(3));
	const posX = Number((Math.cos(angle) * 6).toFixed(2));
	const posZ = Number((Math.sin(angle) * 6).toFixed(2));
	return {
		action: { type: "Move", data: { x: moveX, z: moveZ } },
		observation: {
			auto_tick: autoInjectTick,
			auto_ts: Date.now(),
			player: {
				position: { x: posX, y: 0, z: posZ },
				velocity: { x: moveX, y: 0, z: moveZ },
				state: "moving",
			},
		},
	};
}

function runSingleInjection(rl, fromAuto = false) {
	const payload = buildAutoInjectPayload();
	injectActionEvent(payload);
	if (!isBusy) {
		if (agent.state.messages.length === 0) {
			if (!fromAuto) {
				output.write("speech> Injected and queued. Send first message or run /continue after one turn exists.\n");
			}
			printPrompt(rl);
			return;
		}
		// While user is typing, avoid redraw/noise from auto loop.
		if (fromAuto && rl.line && rl.line.length > 0) return;
		void runContinue(rl, { silentPrompt: fromAuto });
		return;
	}
	if (!fromAuto) {
		output.write("speech> Injected via steer during active run.\n");
		printPrompt(rl);
	}
}

function stopAutoInject() {
	if (autoInjectTimer) clearInterval(autoInjectTimer);
	autoInjectTimer = null;
	autoInjectIntervalMs = 0;
	autoInjectTemplate = null;
}

function startAutoInject(intervalMs, template, rl) {
	stopAutoInject();
	autoInjectTick = 0;
	autoInjectIntervalMs = intervalMs;
	autoInjectTemplate = template;
	autoInjectTimer = setInterval(() => {
		runSingleInjection(rl, true);
	}, intervalMs);
}

function scheduleUnexpectedEvent(rl) {
	if (unexpectedEventTimer) clearTimeout(unexpectedEventTimer);
	if (!Number.isFinite(unexpectedEventDelayMs) || unexpectedEventDelayMs < 0) return;

	unexpectedEventTimer = setTimeout(() => {
		const payload = {
			action: { type: "Move", data: { x: 0, z: 0 } },
			observation: {
				auto_ts: Date.now(),
				event: "sudden_enemy_contact",
				threat: { type: "ambush", level: "high", distance: 3.2, direction: "left" },
				player: { state: "under_attack", health_delta: -25 },
			},
		};
		injectActionEvent(payload);
		output.write("speech> [event] Unexpected ambush injected.\n");

		if (!isBusy && agent.state.messages.length > 0) {
			if (rl.line && rl.line.length > 0) return;
			void runContinue(rl, { silentPrompt: true });
		}
	}, unexpectedEventDelayMs);
}

agent.subscribe((event) => {
	persistConversation();

	if (event.type === "message_start" && event.message.role === "assistant") {
		assistantSawDelta = false;
		assistantPrefixPrinted = false;
		return;
	}
	if (
		event.type === "message_update" &&
		event.assistantMessageEvent.type === "text_delta"
	) {
		assistantSawDelta = true;
		if (!assistantPrefixPrinted) {
			output.write("speech> ");
			assistantPrefixPrinted = true;
		}
		output.write(event.assistantMessageEvent.delta);
		return;
	}
	if (event.type === "message_end" && event.message.role === "assistant") {
		let fullText = "";
		const errorMessage = event.message.errorMessage;
		const hasText = event.message.content.some((c) => c.type === "text" && c.text.trim().length > 0);
		if (!assistantSawDelta) {
			fullText = event.message.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (hasText) {
				output.write(`speech> ${fullText}\n`);
				assistantPrefixPrinted = true;
			}
		} else {
			fullText = event.message.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");
			output.write("\n");
		}
		if (errorMessage) {
			output.write(`[error] ${errorMessage}\n`);
		}
		assistantSawDelta = false;
		assistantPrefixPrinted = false;

		const spoken = extractSpeakSegments(fullText);
		if (spoken.length > 0) {
			for (const seg of spoken) {
				output.write(`[speak] ${seg}\n`);
				audioPlayer?.enqueue(seg);
			}
		}
	}
});

const rl = createInterface({ input, output, terminal: true });
rl.setPrompt("you> ");
console.log(`Speech chat ready with model "${model.id}" (${model.provider}).`);
console.log("Commands: /reset, /quit, /continue, /abort, /inject {\"action\":...,\"observation\":...}");
console.log("          /autoinject <ms> [json], /autoinject off, /autoinject status");
if (Number.isFinite(defaultAutoInjectMs) && defaultAutoInjectMs >= 100) {
	startAutoInject(defaultAutoInjectMs, null, rl);
	console.log(`Auto-inject started by default (${defaultAutoInjectMs}ms).`);
}
if (Number.isFinite(unexpectedEventDelayMs) && unexpectedEventDelayMs >= 0) {
	scheduleUnexpectedEvent(rl);
	console.log(`Unexpected event scheduled in ${unexpectedEventDelayMs}ms.`);
}
if (audioPlayer) {
	audioPlayer
		.start()
		.then(() => {
			console.log(
				`ElevenLabs realtime audio enabled (voice=${elevenLabsVoiceId}, model=${elevenLabsModelId}, format=${elevenLabsOutputFormat}).`,
			);
		})
		.catch((err) => {
			console.error(`[audio] failed to start ElevenLabs realtime playback: ${err instanceof Error ? err.message : String(err)}`);
		});
} else {
	console.log("ElevenLabs realtime audio disabled (set ELEVENLABS_API_KEY + AGENT_A_VOICE_ID/AGENT_VOICE_ID).");
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
		if (isBusy) agent.abort();
		stopAutoInject();
		if (unexpectedEventTimer) clearTimeout(unexpectedEventTimer);
		agent.reset();
		scheduleUnexpectedEvent(rl);
		persistConversation();
		output.write("speech> Context cleared. Auto-inject stopped. Unexpected event rescheduled.\n");
		isBusy = false;
		printPrompt(rl);
		return;
	}

	if (line === "/abort") {
		if (isBusy) {
			agent.abort();
			output.write("speech> Aborted current run.\n");
		} else {
			output.write("speech> Idle.\n");
		}
		return;
	}

	if (line === "/continue") {
		if (isBusy) {
			output.write("speech> Busy; continue is implicit when current turn ends.\n");
			printPrompt(rl);
			return;
		}
		void runContinue(rl);
		return;
	}

	if (line.startsWith("/inject ")) {
		const raw = line.slice("/inject ".length).trim();
		try {
			const payload = JSON.parse(raw);
			autoInjectTemplate = payload;
			runSingleInjection(rl);
		} catch (error) {
			output.write(`speech> Invalid /inject JSON: ${error instanceof Error ? error.message : String(error)}\n`);
			printPrompt(rl);
		}
		return;
	}

	if (line === "/autoinject off") {
		stopAutoInject();
		output.write("speech> Auto-inject stopped.\n");
		printPrompt(rl);
		return;
	}

	if (line === "/autoinject status") {
		if (!autoInjectTimer) {
			output.write("speech> Auto-inject is off.\n");
		} else {
			output.write(`speech> Auto-inject every ${autoInjectIntervalMs}ms (tick=${autoInjectTick}).\n`);
		}
		printPrompt(rl);
		return;
	}

	if (line.startsWith("/autoinject ")) {
		const raw = line.slice("/autoinject ".length).trim();
		const spaceIdx = raw.indexOf(" ");
		const intervalRaw = spaceIdx >= 0 ? raw.slice(0, spaceIdx) : raw;
		const templateRaw = spaceIdx >= 0 ? raw.slice(spaceIdx + 1).trim() : "";
		const intervalMs = Number(intervalRaw);
		if (!Number.isFinite(intervalMs) || intervalMs < 100) {
			output.write("speech> Invalid interval. Use /autoinject <ms> [json], ms >= 100.\n");
			printPrompt(rl);
			return;
		}
		let template = null;
		if (templateRaw) {
			try {
				template = JSON.parse(templateRaw);
			} catch (error) {
				output.write(`speech> Invalid /autoinject JSON: ${error instanceof Error ? error.message : String(error)}\n`);
				printPrompt(rl);
				return;
			}
		}
		startAutoInject(intervalMs, template, rl);
		output.write(`speech> Auto-inject started (${intervalMs}ms).\n`);
		printPrompt(rl);
		return;
	}

	if (isBusy) {
		agent.steer({ role: "user", content: [{ type: "text", text: line }], timestamp: Date.now() });
		output.write("speech> Queued steer message.\n");
		printPrompt(rl);
		return;
	}

	const userMessage = { role: "user", content: [{ type: "text", text: line }], timestamp: Date.now() };
	if (agent.state.messages.length === 0) {
		// Bootstrap first turn without prompt(): seed state then continue.
		agent.appendMessage(userMessage);
	} else {
		agent.steer(userMessage);
	}
	void runContinue(rl);
});

rl.on("SIGINT", () => {
	if (isBusy) {
		agent.abort();
		output.write("\nspeech> Aborted.\n");
		isBusy = false;
		printPrompt(rl);
		return;
	}
	isClosing = true;
	rl.close();
});

rl.on("close", () => {
	stopAutoInject();
	if (unexpectedEventTimer) clearTimeout(unexpectedEventTimer);
	audioPlayer?.close();
	persistConversation();
	process.exit(0);
});
