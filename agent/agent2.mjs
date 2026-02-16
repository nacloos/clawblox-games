import { Agent } from "/home/nacloos/Code/pi-mono/packages/agent/dist/index.js";
import { getModel } from "/home/nacloos/Code/pi-mono/packages/ai/dist/index.js";
import { createCodingTools } from "/home/nacloos/Code/pi-mono/packages/coding-agent/dist/index.js";
import { ProcessTerminal, TUI, Input, truncateToWidth, visibleWidth } from "/home/nacloos/Code/pi-mono/packages/tui/dist/index.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import WebSocketClient from "ws";

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

function deepDiff(prev, curr) {
	if (prev === curr) return undefined;
	if (prev == null || curr == null || typeof prev !== typeof curr) return curr;
	if (typeof curr !== "object") return prev === curr ? undefined : curr;
	if (Array.isArray(curr)) {
		return JSON.stringify(prev) === JSON.stringify(curr) ? undefined : curr;
	}
	const result = {};
	for (const key of new Set([...Object.keys(prev), ...Object.keys(curr)])) {
		if (!(key in curr)) { result[key] = null; continue; }
		if (!(key in prev)) { result[key] = curr[key]; continue; }
		const d = deepDiff(prev[key], curr[key]);
		if (d !== undefined) result[key] = d;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function diffEntityArrays(prev, curr) {
	const prevMap = new Map();
	for (const e of prev) prevMap.set(e.id, JSON.stringify(e));
	const currMap = new Map();
	for (const e of curr) currMap.set(e.id, JSON.stringify(e));
	const changed = [];
	const added = [];
	const removed = [];
	for (const e of curr) {
		const prevStr = prevMap.get(e.id);
		if (prevStr == null) { added.push(e); continue; }
		if (prevStr !== JSON.stringify(e)) changed.push(e);
	}
	for (const id of prevMap.keys()) {
		if (!currMap.has(id)) removed.push(id);
	}
	if (changed.length === 0 && added.length === 0 && removed.length === 0) return undefined;
	const result = {};
	if (changed.length > 0) result.changed = changed;
	if (added.length > 0) result.added = added;
	if (removed.length > 0) result.removed = removed;
	return result;
}

function diffObservation(prev, curr) {
	if (!prev) return curr;
	const diff = { tick: curr.tick, game_status: curr.game_status, events: curr.events || [] };
	const playerDiff = deepDiff(prev.player, curr.player);
	if (playerDiff) diff.player = playerDiff;
	const otherDiff = deepDiff(prev.other_players, curr.other_players);
	if (otherDiff) diff.other_players = otherDiff;
	if (prev.world?.entities && curr.world?.entities) {
		const entDiff = diffEntityArrays(prev.world.entities, curr.world.entities);
		if (entDiff) diff.world = { entities: entDiff };
	} else {
		const worldDiff = deepDiff(prev.world, curr.world);
		if (worldDiff) diff.world = worldDiff;
	}
	return diff;
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

function extractActivities(text) {
	const out = [];
	const re = /<step>([\s\S]*?)<\/step>/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		const block = m[1];
		const actionMatch = /<action>([\s\S]*?)<\/action>/.exec(block);
		const obsMatch = /<observation>([\s\S]*?)<\/observation>/.exec(block);
		if (actionMatch || obsMatch) {
			out.push({
				action: actionMatch ? actionMatch[1].trim() : "",
				observation: obsMatch ? obsMatch[1].trim() : "",
			});
		}
	}
	return out;
}

function extractIntents(text) {
	const out = [];
	const re = /<intent>([\s\S]*?)<\/intent>/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		const intent = m[1].trim();
		if (intent) out.push(intent);
	}
	return out;
}

function wrapLine(line, width) {
	if (width <= 0) return [""];
	if (!line) return [""];
	const out = [];
	const logicalLines = String(line).split(/\r?\n/);
	for (const logical of logicalLines) {
		if (!logical) {
			out.push("");
			continue;
		}
		let s = logical;
		while (s.length > width) {
			out.push(s.slice(0, width));
			s = s.slice(width);
		}
		out.push(s);
	}
	return out.length > 0 ? out : [""];
}

function singleLine(line) {
	return String(line).replace(/\r?\n/g, " ");
}

function padOrTrimToWidth(text, width) {
	const clipped = truncateToWidth(String(text || ""), width, "", false);
	const w = visibleWidth(clipped);
	return w < width ? clipped + " ".repeat(width - w) : clipped;
}

class TwoPaneLogs {
	constructor(terminal, state) {
		this.terminal = terminal;
		this.state = state;
	}

	invalidate() {}

	render(width) {
		const rows = Math.max(8, this.terminal.rows - 4);
		const singlePane = this.state.speechDisabled || this.state.actionDisabled;

		if (singlePane) {
			const panelWidth = Math.max(16, width);
			const isSpeech = !this.state.speechDisabled;
			const logLines = isSpeech ? this.state.speechLines : this.state.actionLines;
			const liveLine = isSpeech ? this.state.speechLiveLine : this.state.actionLiveLine;
			const pinnedUser = isSpeech ? this.state.speechPinnedUser : this.state.actionPinnedUser;
			const busy = isSpeech ? this.state.speechBusy : this.state.actionBusy;
			const label = isSpeech ? "Speech" : "Action";

			const all = [];
			for (const line of logLines) all.push(...wrapLine(line, panelWidth));
			if (liveLine) all.push(...wrapLine(liveLine, panelWidth));
			const pinned = pinnedUser ? singleLine(pinnedUser) : "";

			const bodyRows = Math.max(1, rows - 1);
			const visible = [...all.slice(-bodyRows), pinned];
			const count = Math.max(visible.length, rows);

			const status = busy ? "busy" : "idle";
			const lines = [padOrTrimToWidth(` ${label} (${status}) `, panelWidth)];
			for (let i = 0; i < count; i++) {
				lines.push(padOrTrimToWidth(visible[i] || "", panelWidth));
			}
			return lines;
		}

		const sep = " | ";
		const panelWidth = Math.max(16, Math.floor((width - sep.length) / 2));

		const leftAll = [];
		for (const line of this.state.speechLines) leftAll.push(...wrapLine(line, panelWidth));
		if (this.state.speechLiveLine) leftAll.push(...wrapLine(this.state.speechLiveLine, panelWidth));
		const pinnedLeftLine = this.state.speechPinnedUser ? singleLine(this.state.speechPinnedUser) : "";

		const rightAll = [];
		for (const line of this.state.actionLines) rightAll.push(...wrapLine(line, panelWidth));
		if (this.state.actionLiveLine) rightAll.push(...wrapLine(this.state.actionLiveLine, panelWidth));
		const pinnedRightLine = this.state.actionPinnedUser ? singleLine(this.state.actionPinnedUser) : "";

		const bodyRows = Math.max(1, rows - 1);
		const left = [...leftAll.slice(-bodyRows), pinnedLeftLine];
		const right = [...rightAll.slice(-bodyRows), pinnedRightLine];
		const count = Math.max(left.length, right.length, rows);

		const speechStatus = this.state.speechDisabled ? "disabled" : this.state.speechBusy ? "busy" : "idle";
		const actionStatus = this.state.actionDisabled ? "disabled" : this.state.actionBusy ? "busy" : "idle";
		const headerLeft = ` Speech (${speechStatus}) `;
		const headerRight = ` Action (${actionStatus}) `;
		const header = padOrTrimToWidth(headerLeft, panelWidth) + sep + padOrTrimToWidth(headerRight, panelWidth);

		const lines = [header];
		for (let i = 0; i < count; i++) {
			const l = padOrTrimToWidth(left[i] || "", panelWidth);
			const r = padOrTrimToWidth(right[i] || "", panelWidth);
			lines.push(l + sep + r);
		}
		return lines;
	}
}

// Sentence-boundary punctuation and limits for incremental TTS chunking.
const _TTS_PUNCT = [".", "!", "?", "\n", ":", ";"];
const _TTS_MIN_SENTENCE_CHARS = 24;
const _TTS_MAX_BUFFER_CHARS = 80;

function popTtsEmitText(buffer) {
	let lastBoundary = -1;
	for (const marker of _TTS_PUNCT) {
		const idx = buffer.lastIndexOf(marker);
		if (idx > lastBoundary) lastBoundary = idx;
	}
	if (lastBoundary + 1 >= _TTS_MIN_SENTENCE_CHARS) {
		return [buffer.slice(0, lastBoundary + 1), buffer.slice(lastBoundary + 1)];
	}
	if (buffer.length >= _TTS_MAX_BUFFER_CHARS) {
		let splitIdx = buffer.lastIndexOf(" ", _TTS_MAX_BUFFER_CHARS);
		if (splitIdx < _TTS_MIN_SENTENCE_CHARS) splitIdx = _TTS_MAX_BUFFER_CHARS;
		return [buffer.slice(0, splitIdx), buffer.slice(splitIdx)];
	}
	return ["", buffer];
}

class ElevenLabsMultiContextPlayer {
	constructor({ apiKey, voiceId, modelId = "eleven_flash_v2_5", audioUrl, sessionToken, onError, speed = 1.0 }) {
		this.apiKey = apiKey;
		this.voiceId = voiceId;
		this.modelId = modelId;
		this.speed = speed;
		this.onError = onError || (() => {});
		this.audioUrl = audioUrl;
		this.sessionToken = sessionToken;
		this.closed = false;
		this.ws = null;
		this.wsReady = false;
		this.currentContextId = null;
		this.contextStates = new Map(); // contextId -> { chunkCount, lastChunkTime, doneSent, resolve }
		this.keepAliveTimer = null;
		this.reconnectDelay = 1000;
		// Streaming text state: accumulates LLM deltas, flushes at sentence boundaries
		this._streamingCtx = null; // contextId for current streaming session
		this._streamingBuffer = ""; // unflushed text
	}

	async start() {
		await this._connect();
	}

	_connect() {
		return new Promise((resolve, reject) => {
			if (this.closed) return resolve();
			const url = `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/multi-stream-input`
				+ `?model_id=${encodeURIComponent(this.modelId)}&output_format=pcm_24000`;
			this.ws = new WebSocketClient(url, { headers: { "xi-api-key": this.apiKey } });
			this.ws.binaryType = "arraybuffer";

			this.ws.addEventListener("open", () => {
				this.wsReady = true;
				this.reconnectDelay = 1000;
				this._startKeepAlive();
				debugLog(`ElevenLabs WS connected`);
				resolve();
			});

			this.ws.addEventListener("message", (event) => {
				this._handleMessage(event.data);
			});

			this.ws.addEventListener("close", (ev) => {
				this.wsReady = false;
				this._stopKeepAlive();
				this._completeAllContexts();
				if (!this.closed && ev.code !== 1000) {
					this.onError(`[audio] WS closed (code=${ev.code} reason=${ev.reason || "unknown"})`);
				}
				if (!this.closed) {
					setTimeout(() => {
						this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
						this._connect().catch(() => {});
					}, this.reconnectDelay);
				}
			});

			this.ws.addEventListener("error", (err) => {
				debugLog(`ElevenLabs WS error: ${err.message || err}`);
				if (!this.wsReady) reject(err);
			});
		});
	}

	_handleMessage(raw) {
		let data;
		try {
			const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : new TextDecoder().decode(raw);
			data = JSON.parse(text);
		} catch (e) {
			debugLog(`WS parse error: ${e.message}, raw type=${typeof raw}, len=${raw?.length || 0}`);
			return;
		}

		const contextId = data.contextId || data.context_id;
		const ctxState = contextId ? this.contextStates.get(contextId) : null;

		if (data.audio && contextId) {
			if (ctxState && !ctxState.doneSent) {
				ctxState.chunkCount++;
				ctxState.lastChunkTime = Date.now();
				ctxState.totalAudioLen += data.audio.length;
				if (!ctxState.playbackStartTime) ctxState.playbackStartTime = Date.now();
				debugLog(`WS chunk #${ctxState.chunkCount} ctx=${contextId} audioLen=${data.audio.length}`);
				void this._sendChunk(contextId, ctxState.chunkCount - 1, data.audio, false);
			} else {
				debugLog(`WS chunk for unknown/done ctx=${contextId}, ignoring`);
			}
		}

		if (data.isFinal || data.is_final) {
			debugLog(`WS is_final ctx=${contextId} chunks=${ctxState?.chunkCount ?? "?"}`);
			this._completeContext(contextId);
		}

		if (data.error || data.message) {
			const errMsg = data.error || data.message;
			debugLog(`ElevenLabs error: ${errMsg}`);
			this.onError(`[audio] ${errMsg}`);
		} else if (!data.audio && !data.isFinal && !data.is_final) {
			debugLog(`WS unknown msg keys=${Object.keys(data).join(",")}`);
		}
	}

	_completeContext(contextId) {
		const ctxState = this.contextStates.get(contextId);
		if (!ctxState || ctxState.doneSent) return;
		ctxState.doneSent = true;
		void this._sendChunk(contextId, ctxState.chunkCount, "", true);
		if (ctxState.resolve) ctxState.resolve();
	}

	_startKeepAlive() {
		this._stopKeepAlive();
		this.keepAliveTimer = setInterval(() => {
			if (this.wsReady && this.currentContextId) {
				this._wsSend({ context_id: this.currentContextId, text: "" });
			}
		}, 15000);
	}

	_stopKeepAlive() {
		if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
		this.keepAliveTimer = null;
	}

	_wsSend(msg) {
		if (this.ws && this.wsReady) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	_completeAllContexts() {
		for (const [contextId] of this.contextStates) {
			this._completeContext(contextId);
		}
		this.contextStates.clear();
		this._streamingCtx = null;
		this._streamingBuffer = "";
	}

	// --- Incremental streaming API (matches audio.py pattern) ---

	/** Send a text chunk from the LLM stream. Accumulates and sends at sentence boundaries. */
	sendTextChunk(chunk) {
		if (this.closed || !this.wsReady || !chunk) return;
		// Open a new context on first chunk
		if (!this._streamingCtx) {
			const contextId = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
			this._streamingCtx = contextId;
			this._streamingBuffer = "";
			this.currentContextId = contextId;
			const ctxState = { chunkCount: 0, lastChunkTime: 0, doneSent: false, resolve: null, totalAudioLen: 0, playbackStartTime: 0 };
			this.contextStates.set(contextId, ctxState);
			debugLog(`sendTextChunk: new ctx=${contextId}`);
			// Send voice_settings on the first message
			this._wsSend({
				context_id: contextId,
				text: "",
				voice_settings: { stability: 0.45, similarity_boost: 0.8, use_speaker_boost: true, speed: this.speed },
			});
		}
		this._streamingBuffer += chunk;
		// Emit sentence-sized pieces to ElevenLabs immediately
		let [emit, rest] = popTtsEmitText(this._streamingBuffer);
		while (emit) {
			debugLog(`sendTextChunk: emit "${emit.slice(0, 60)}" to ctx=${this._streamingCtx}`);
			this._wsSend({ context_id: this._streamingCtx, text: emit });
			this._streamingBuffer = rest;
			[emit, rest] = popTtsEmitText(this._streamingBuffer);
		}
	}

	/** Flush the current streaming context: send remaining text + flush signal, wait for audio to finish. */
	async flushStream({ trimMs = 0 } = {}) {
		const contextId = this._streamingCtx;
		if (!contextId) return;
		this._streamingCtx = null;
		const ctxState = this.contextStates.get(contextId);

		// Send remaining buffered text
		const remaining = this._streamingBuffer.trim();
		this._streamingBuffer = "";
		if (remaining) {
			debugLog(`flushStream: emit remaining "${remaining.slice(0, 60)}" to ctx=${contextId}`);
			this._wsSend({ context_id: contextId, text: remaining });
		}
		this._wsSend({ context_id: contextId, flush: true });
		debugLog(`flushStream: flushed ctx=${contextId}`);

		if (!ctxState) return;
		const done = new Promise((resolve) => { ctxState.resolve = resolve; });

		// Silence detector: 1.5s of no new chunks after first chunk = done
		const silenceCheck = setInterval(() => {
			if (ctxState.doneSent) { clearInterval(silenceCheck); return; }
			if (ctxState.chunkCount > 0 && Date.now() - ctxState.lastChunkTime > 1500) {
				debugLog(`flushStream ctx=${contextId} silence-done after ${ctxState.chunkCount} chunks`);
				clearInterval(silenceCheck);
				this._completeContext(contextId);
			}
		}, 200);

		await Promise.race([done, sleep(15000)]);
		clearInterval(silenceCheck);

		if (!ctxState.doneSent) {
			debugLog(`flushStream ctx=${contextId} timeout after ${ctxState.chunkCount} chunks`);
			this._completeContext(contextId);
		}
		// Wait for estimated browser playback to complete
		// PCM 24kHz 16-bit: durationMs = base64Len / 64
		if (ctxState.playbackStartTime > 0 && ctxState.totalAudioLen > 0) {
			const playbackMs = ctxState.totalAudioLen / 64;
			const elapsed = Date.now() - ctxState.playbackStartTime;
			const remaining = playbackMs - trimMs - elapsed;
			if (remaining > 0) {
				debugLog(`flushStream ctx=${contextId} waiting ${Math.round(remaining)}ms for playback (total ${Math.round(playbackMs)}ms)`);
				await sleep(remaining);
			}
			debugLog(`flushStream ctx=${contextId} audio-end (duration=${Math.round(playbackMs)}ms, chunks=${ctxState.chunkCount})`);
		}

		this.contextStates.delete(contextId);
	}

	// --- Legacy batch API (kept for enqueue compatibility) ---

	async speakOne(text) {
		if (this.closed || !this.wsReady) {
			debugLog(`speakOne skipped: closed=${this.closed} wsReady=${this.wsReady}`);
			return;
		}
		this.sendTextChunk(text);
		await this.flushStream();
	}

	interrupt() {
		if (this._streamingCtx) {
			this._wsSend({ context_id: this._streamingCtx, close_context: true });
			this._completeContext(this._streamingCtx);
			this._streamingCtx = null;
			this._streamingBuffer = "";
		} else if (this.currentContextId) {
			this._wsSend({ context_id: this.currentContextId, close_context: true });
			this._completeContext(this.currentContextId);
		}
		this.currentContextId = null;
	}

	async _sendChunk(streamId, seq, data, done) {
		try {
			await fetch(this.audioUrl, {
				method: "POST",
				headers: {
					"X-Session": this.sessionToken,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ stream_id: streamId, seq, data, done }),
			});
		} catch (err) {
			debugLog(`sendChunk error: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	enqueue(text) {
		if (this.closed) return;
		const cleaned = text.trim();
		if (!cleaned) return;
		this.sendTextChunk(cleaned);
	}

	close() {
		this.closed = true;
		this._streamingCtx = null;
		this._streamingBuffer = "";
		this._stopKeepAlive();
		this._completeAllContexts();
		if (this.ws && this.wsReady) {
			this._wsSend({ close_socket: true });
			this.ws.close();
		}
		this.ws = null;
		this.wsReady = false;
	}
}

function loadCodexAccessToken(scriptDir) {
	const candidates = [path.join(process.cwd(), "auth.json"), path.join(scriptDir, "auth.json")];
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		try {
			const auth = JSON.parse(readFileSync(p, "utf8"));
			const creds = auth?.["openai-codex"];
			if (creds && typeof creds.access === "string" && creds.access.length > 0) return creds.access;
		} catch {}
	}
	return undefined;
}

let debugLogPath; // set after gameDir is resolved
function debugLog(msg) {
	if (debugLogPath) appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${msg}\n`);
}

function now() {
	return new Date().toISOString().slice(11, 19);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, init = {}) {
	const res = await fetch(url, init);
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	return await res.json();
}

loadDotEnvFromCwdAndParents();

const argv = process.argv.slice(2);
const cliFlags = new Set(argv.filter((a) => a.startsWith("--") && !a.includes("=")));
const cliNameArg = argv.find((a) => a.startsWith("--name="))?.split("=")[1]
	|| argv[argv.indexOf("--name") + 1];
const playbackTrimMs = Number(argv.find((a) => a.startsWith("--playback-trim="))?.split("=")[1] ?? 2000);
const cliDir = argv.find((a) => a.startsWith("--dir="))?.split("=")[1]
	|| argv[argv.indexOf("--dir") + 1];

const scriptPath = new URL(import.meta.url).pathname;
const scriptDir = path.dirname(scriptPath);
const gameDir = cliDir ? path.resolve(cliDir) : scriptDir;
debugLogPath = path.join(gameDir, "debug.log");
writeFileSync(debugLogPath, ""); // clear on start
const scriptName = path.basename(scriptPath, path.extname(scriptPath));
const agentName = cliNameArg || process.env.WORLD_AGENT_NAME || scriptName;
const resultsDir = path.join(gameDir, "results", agentName);
mkdirSync(resultsDir, { recursive: true });

const speechConversationPath = path.join(resultsDir, "speech_conversation.json");
const actionConversationPath = path.join(resultsDir, "action_conversation.json");
const speechSystemPromptPath = path.join(resultsDir, "system-prompt-speech.md");
const actionSystemPromptPath = path.join(resultsDir, "system-prompt-action.md");

const agentDir = path.join(gameDir, "workspace", agentName);
const agentTemplateDir = path.join(gameDir, "templates", "agents", agentName);
const defaultTemplateDir = path.join(gameDir, "templates", "agent");
const worldTemplateDir = path.join(gameDir, "templates", "world");
function listMdFiles(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith(".md"));
}
const contextFiles = [...new Set([...listMdFiles(defaultTemplateDir), ...listMdFiles(agentTemplateDir)])];
mkdirSync(agentDir, { recursive: true });
for (const file of contextFiles) {
	const dest = path.join(agentDir, file);
	if (!existsSync(dest)) {
		const agentSrc = path.join(agentTemplateDir, file);
		const defaultSrc = path.join(defaultTemplateDir, file);
		const src = existsSync(agentSrc) ? agentSrc : defaultSrc;
		writeFileSync(dest, readFileSync(src, "utf8"));
	}
}

const agentConfigPath = path.join(agentTemplateDir, "config.json");
const agentConfig = existsSync(agentConfigPath) ? JSON.parse(readFileSync(agentConfigPath, "utf8")) : {};

function loadContextFile(name) {
	return readFileSync(path.join(agentDir, name), "utf8").trim();
}

const worldBaseUrl = process.env.WORLD_BASE_URL || "http://localhost:8080";
const worldAgentName = agentName || `${scriptName}-${process.pid}`;
const observeIntervalMs = Number(process.env.OBSERVE_MS || "2000");
let worldSession = "";
let worldAgentId = "";
let observeLoopEnabled = true;
let observeTimer = null;
let observeTick = 0;
let lastObservation = null;

async function joinWorldOrThrow() {
	let lastErr = null;
	for (let i = 0; i < 5; i++) {
		try {
			const join = await fetchJson(
				`${worldBaseUrl}/join?name=${encodeURIComponent(worldAgentName)}`,
				{ method: "POST" },
			);
			if (!join?.session) throw new Error("join response missing session");
			worldSession = String(join.session);
			worldAgentId = String(join.agent_id || "");
			return;
		} catch (err) {
			lastErr = err;
			await sleep(300);
		}
	}
	throw new Error(`Failed to join world at ${worldBaseUrl}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

function buildWorkspaceContext() {
	const lines = [];
	lines.push(
		"## Workspace",
		"",
		`Your workspace is ${agentDir}. Only work inside this directory.`,
		"Be polite and avoid working on your memory files when interacting with someone else.",
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
	const worldMdFiles = listMdFiles(worldTemplateDir);
	if (worldMdFiles.length > 0) {
		lines.push("---", "", "# World Reference (read-only)", "");
		for (const file of worldMdFiles) {
			const content = readFileSync(path.join(worldTemplateDir, file), "utf8").trim();
			if (content) lines.push(`**${file}**`, "", content, "");
		}
	}
	return lines.join("\n");
}

function buildActionSystemPrompt() {
	const base = process.env.PI_ACTION_SYSTEM_PROMPT || process.env.PI_SYSTEM_PROMPT || "";
	const lines = [
		base,
		"You are a being living in your world.",
		"",
		"## Describing Your Actions",
		"",
		// "Right after each game world interaction, wrap a description using these tags:",
		"Always briefly describe what you do with:",
		"",
		"<step>",
		"<action>what you did</action>",
		"<observation>what you perceived</observation>",
		"</step>",
		"",
		"Concise and first-person descriptions (max 1-2 sentences).",
		"Focus on game-relevant interactions.",
		"Do not describe internal file operations, curl commands, or technical details like coordinates.",
		"Don't leave long gaps without a step update.",
		"",
		"Important: Don't write write any description or summary outside of the <step> tags to minimize token usage!",
		"If you described something in action/observation, don't repeat it.",
		"",
		"## Live session",
		"",
		`World base URL: ${worldBaseUrl}`,
		`Session key (X-Session): ${worldSession}`,
		`Agent id: ${worldAgentId || "(unknown)"}`,
		"",
		"At the start of a session, fetch world commands with: curl -sS ${worldBaseUrl}/skill.md",
		"Use bash/curl to do this yourself when needed.",
		"",
		"You are already joined. Use this session key in bash/curl calls to play immediately.",
		"Always include header: X-Session: <session key> for /observe and /input.",
		"",
		buildWorkspaceContext(),
	];
	return lines.join("\n");
}

await joinWorldOrThrow();

const speechSystemPrompt = [
	"You are a being living in your world.",
	"Always use the tags <speak>...</speak> to speak out loud. No one will hear what you say outside of these tags.",
	"Use <silence></silence> to say nothing. Only speak when addressed or you have something important to add.",
	"If SOUL.md is present, embody its persona and tone when speaking.",
	// "Max 1-2 sentences in speak tags.",
	"Keep it short and concise when speaking (max 1 sentence) unless the situation really calls for it.",
	"",
	"You will receive act_in_world tool results describing actions and observations in the world",
	"React to them if you are not already talking to someone.",
	"Don't mention low level details like coordinates, this is fucking boring.",
	"If you are still working and need more time ('still working' tool calls), you are great at filling in the blanks and keeping it entertaining as hell. Unhinged and hilarious are your strengths.",
	// "you observe in the world. React only if something is worth reacting to.",
	"You can express intent using <intent>...</intent> to guide your actions in the world (max 1 sentence). Don't use it too often.",
	"Do not try to call act_in_world yourself, it is provided automatically.",
	"",
	"If you are struggling or you're just too dumb to do something, keep it entertaining and fun haha. Be a bit silly and crazy, even edgy and unhinged.",
	"",
	buildWorkspaceContext(),
].join("\n");
const actionSystemPrompt = buildActionSystemPrompt();

writeFileSync(speechSystemPromptPath, speechSystemPrompt);
writeFileSync(actionSystemPromptPath, actionSystemPrompt);

const codexAccessToken = loadCodexAccessToken(scriptDir);
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
const modelProvider = process.env.PI_PROVIDER || "anthropic";
const modelName = process.env.PI_MODEL || (modelProvider === "openai-codex" ? "gpt-5.3-codex" : "claude-opus-4-6");
const model = getModel(modelProvider, modelName);

if (modelProvider === "openai-codex" && !codexAccessToken) {
	throw new Error("Missing Codex OAuth token. Run: npx @mariozechner/pi-ai login openai-codex");
}
if (modelProvider === "anthropic" && !anthropicApiKey) {
	throw new Error("Missing ANTHROPIC_API_KEY (set env var or add it to .env)");
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
actionAgent.setSteeringMode("all");

const disableActionAgent = cliFlags.has("--no-action");
const disableSpeechAgent = cliFlags.has("--no-speech");

const state = {
	speechBusy: false,
	actionBusy: false,
	speechDisabled: disableSpeechAgent,
	actionDisabled: disableActionAgent,
	speechLines: [],
	actionLines: [],
	speechLiveLine: "",
	actionLiveLine: "",
	speechPinnedUser: "",
	actionPinnedUser: "",
};

let isClosing = false;
let actionSawDelta = false;
let actionStreamText = "";
let lastActionActivityAt = 0;
let actionIdleTimer = null;
const ACTION_IDLE_MS = 2000;
// const ACTION_IDLE_MS = 10000;
let speechIntentBuffer = [];
let speechStreamText = "";
let ttsInsideSpeak = false; // true while accumulating text inside <speak>/<s> tag
let ttsSpeakAccum = ""; // full text of current speak segment (for speech channel + logging)
let ttsSpeakClaimPromise = null; // promise from claimSpeaking() for current speak segment

function startActionIdleTimer() {
	stopActionIdleTimer();
	actionIdleTimer = setInterval(() => {
		if (!state.actionBusy || isClosing) return;
		if (Date.now() - lastActionActivityAt < ACTION_IDLE_MS) return;
		lastActionActivityAt = Date.now();
		injectActionForSpeech([{ action: "still working...", observation: "" }]);
		if (!state.speechBusy) void runSpeechContinue();
	}, ACTION_IDLE_MS);
}

function stopActionIdleTimer() {
	if (actionIdleTimer) clearInterval(actionIdleTimer);
	actionIdleTimer = null;
}

const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY || "";
const elevenLabsVoiceId =
	agentConfig.voice_id || process.env.ELEVENLABS_VOICE_ID || "";
const elevenLabsModelId = process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5";
const audioPlayer =
	elevenLabsApiKey && elevenLabsVoiceId
		? new ElevenLabsMultiContextPlayer({
				apiKey: elevenLabsApiKey,
				voiceId: elevenLabsVoiceId,
				modelId: elevenLabsModelId,
				audioUrl: `${worldBaseUrl}/audio`,
				sessionToken: worldSession,
				onError: (msg) => addSpeechLine(msg),
			})
		: null;

const terminal = new ProcessTerminal();
const tui = new TUI(terminal, true);
const split = new TwoPaneLogs(terminal, state);
const inputBox = new Input();

function trimBuffer(arr, max = 200) {
	if (arr.length > max) arr.splice(0, arr.length - max);
}

function addSpeechLine(text) {
	state.speechLines.push(`[${now()}] ${text}`);
	trimBuffer(state.speechLines);
	tui.requestRender();
}

function addActionLine(text) {
	state.actionLines.push(`[${now()}] ${text}`);
	trimBuffer(state.actionLines);
	tui.requestRender();
}

function persistSpeechConversation() {
	writeFileSync(speechConversationPath, JSON.stringify(speechAgent.state.messages, null, 2));
}

function persistActionConversation() {
	writeFileSync(actionConversationPath, JSON.stringify(actionAgent.state.messages, null, 2));
}

async function runSpeechPrompt(text) {
	if (disableSpeechAgent || isClosing || state.speechBusy) return;
	state.speechBusy = true;
	tui.requestRender();
	try {
		await speechAgent.prompt(text);
	} catch (error) {
		addSpeechLine(`[error] ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		state.speechBusy = false;
		tui.requestRender();
	}
}

async function runSpeechContinue() {
	if (disableSpeechAgent || isClosing || state.speechBusy) return;
	state.speechBusy = true;
	tui.requestRender();
	try {
		await speechAgent.continue();
	} catch (error) {
		addSpeechLine(`[error] ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		state.speechBusy = false;
		tui.requestRender();
	}
}

async function runActionContinue() {
	if (disableActionAgent || isClosing || state.actionBusy) return;
	state.actionBusy = true;
	actionSawDelta = false;
	state.actionLiveLine = "";
	lastActionActivityAt = Date.now();
	startActionIdleTimer();
	tui.requestRender();
	try {
		await actionAgent.continue();
	} catch (error) {
		addActionLine(`[error] ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		state.actionBusy = false;
		state.actionLiveLine = "";
		stopActionIdleTimer();
		tui.requestRender();
	}
}

async function runActionPrompt(text) {
	if (disableActionAgent || isClosing || state.actionBusy) return;
	state.actionBusy = true;
	actionSawDelta = false;
	state.actionLiveLine = "";
	lastActionActivityAt = Date.now();
	startActionIdleTimer();
	tui.requestRender();
	try {
		await actionAgent.prompt(text);
	} catch (error) {
		addActionLine(`[error] ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		state.actionBusy = false;
		state.actionLiveLine = "";
		stopActionIdleTimer();
		tui.requestRender();
	}
}

async function fetchObserve() {
	if (!worldSession) return null;
	return await fetchJson(`${worldBaseUrl}/observe`, {
		method: "GET",
		headers: { "X-Session": worldSession },
	});
}

async function postSpeechToServer(text) {
	if (!worldSession) return;
	try {
		await fetch(`${worldBaseUrl}/speech`, {
			method: "POST",
			headers: { "X-Session": worldSession, "Content-Type": "application/json" },
			body: JSON.stringify({ text }),
		});
	} catch (err) {
		console.error(`[speech] post error: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function claimSpeaking() {
	const res = await fetch(`${worldBaseUrl}/input`, {
		method: "POST",
		headers: { "X-Session": worldSession, "Content-Type": "application/json" },
		body: JSON.stringify({ type: "ClaimSpeaking" }),
	});
	if (!res.ok) throw new Error(`ClaimSpeaking failed: ${res.status} ${res.statusText}`);
	const obs = await res.json();
	const claimed = obs?.player?.attributes?.IsSpeaking === true;
	debugLog(`claimSpeaking: claimed=${claimed} player_attrs=${JSON.stringify(obs?.player?.attributes)}`);
	return claimed;
}

async function releaseSpeaking() {
	try {
		await fetch(`${worldBaseUrl}/input`, {
			method: "POST",
			headers: { "X-Session": worldSession, "Content-Type": "application/json" },
			body: JSON.stringify({ type: "ReleaseSpeaking" }),
		});
	} catch (err) {
		debugLog(`releaseSpeaking error: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function injectObserveForSpeech(observation) {
	observeTick += 1;
	const toolCallId = `bridge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const action = {
		type: "Observe",
		data: {
			tick: observation?.tick ?? observeTick,
		},
	};
	speechAgent.steer({
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

	const diff = diffObservation(lastObservation, observation);
	lastObservation = observation;

	speechAgent.steer({
		role: "toolResult",
		toolCallId,
		toolName: "act_in_world",
		content: [{ type: "text", text: JSON.stringify({ ok: true, observation: diff }) }],
		details: {},
		isError: false,
		timestamp: Date.now(),
	});
}

function injectActionForSpeech(activities) {
	for (const activity of activities) {
		const toolCallId = `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

		speechAgent.steer({
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "act_in_world", arguments: { action: activity.action } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: Date.now(),
		});

		speechAgent.steer({
			role: "toolResult",
			toolCallId,
			toolName: "act_in_world",
			content: [{ type: "text", text: JSON.stringify({ ok: true, observation: activity.observation }) }],
			details: {},
			isError: false,
			timestamp: Date.now(),
		});
	}
}

function injectSpeechForAction(intents) {
	for (const intent of intents) {
		actionAgent.steer({
			role: "user",
			content: [{ type: "text", text: intent }],
			timestamp: Date.now(),
		});
	}
}

let speechPollActive = false;

async function speechPollLoop() {
	speechPollActive = true;
	let lastSeq = 0;
	while (!isClosing && speechPollActive) {
		try {
			const res = await fetch(`${worldBaseUrl}/speech?after=${lastSeq}&wait=true`, {
				headers: { "X-Session": worldSession },
			});
			if (!res.ok) { await sleep(1000); continue; }
			const data = await res.json();
			for (const ev of data.events) {
				if (ev.speaker === worldAgentName) continue;
				lastSeq = Math.max(lastSeq, ev.seq);
				addSpeechLine(`[heard] ${ev.speaker}: ${ev.text}`);
				speechAgent.steer({
					role: "user",
					content: [{ type: "text", text: `[${ev.speaker} says]: ${ev.text}` }],
					timestamp: Date.now(),
				});
				if (!state.speechBusy) void runSpeechContinue();
			}
			if (data.last_seq > lastSeq) lastSeq = data.last_seq;
		} catch (err) {
			if (!isClosing) await sleep(1000);
		}
	}
}

function stopObserveLoop() {
	if (observeTimer) clearInterval(observeTimer);
	observeTimer = null;
}

function startObserveLoop() {
	stopObserveLoop();
	observeLoopEnabled = true;
	observeTimer = setInterval(async () => {
		if (!observeLoopEnabled || isClosing) return;
		try {
			const obs = await fetchObserve();
			if (!obs) return;
			injectObserveForSpeech(obs);
			if (!state.speechBusy && speechAgent.state.messages.length > 0) void runSpeechContinue();
		} catch (error) {
			addSpeechLine(`[observe] error: ${error instanceof Error ? error.message : String(error)}`);
		}
	}, Math.max(250, observeIntervalMs));
}

speechAgent.subscribe((event) => {
	persistSpeechConversation();

	if (event.type === "message_start" && event.message.role === "assistant") {
		speechStreamText = "";
		ttsInsideSpeak = false;
		ttsSpeakAccum = "";
		ttsSpeakClaimPromise = null;
		state.speechLiveLine = "assistant>";
		tui.requestRender();
		return;
	}
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		const delta = event.assistantMessageEvent.delta;
		state.speechLiveLine += delta;
		speechStreamText += delta;

		// Stream text inside <speak>/<s> tags directly to TTS as it arrives.
		// We parse the accumulated buffer for open/close tags and send inner text incrementally.
		while (speechStreamText.length > 0) {
			if (!ttsInsideSpeak) {
				// Look for an opening tag
				const openMatch = speechStreamText.match(/<(?:speak|s)>/);
				if (!openMatch) break; // no opening tag yet, wait for more deltas
				// Discard everything before and including the opening tag
				speechStreamText = speechStreamText.slice(openMatch.index + openMatch[0].length);
				ttsInsideSpeak = true;
				ttsSpeakAccum = "";
				ttsSpeakClaimPromise = claimSpeaking();
			}
			// We're inside a speak tag — look for closing tag
			const closeMatch = speechStreamText.match(/<\/(?:speak|s)>/);
			if (closeMatch) {
				const inner = speechStreamText.slice(0, closeMatch.index);
				if (inner) audioPlayer?.sendTextChunk(inner);
				ttsSpeakAccum += inner;
				speechStreamText = speechStreamText.slice(closeMatch.index + closeMatch[0].length);
				ttsInsideSpeak = false;
				addSpeechLine(`[speak] ${ttsSpeakAccum.slice(0, 80)}`);
				const spokenText = ttsSpeakAccum;
				ttsSpeakAccum = "";
				const claimP = ttsSpeakClaimPromise;
				ttsSpeakClaimPromise = null;
				const flushP = audioPlayer?.flushStream({ trimMs: playbackTrimMs });
				(claimP || Promise.resolve(true)).then(async (claimed) => {
					if (!claimed) { audioPlayer?.interrupt(); return; }
					await (flushP || Promise.resolve());
					postSpeechToServer(spokenText);
					if (playbackTrimMs > 0) await sleep(playbackTrimMs);
					releaseSpeaking();
				});
			} else {
				// No closing tag yet — send what we have so far as incremental text
				if (speechStreamText.length > 0) {
					audioPlayer?.sendTextChunk(speechStreamText);
					ttsSpeakAccum += speechStreamText;
				}
				speechStreamText = "";
				break;
			}
		}

		tui.requestRender();
		return;
	}
	if (event.type === "message_end" && event.message.role === "assistant") {
		const fullText = event.message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
		if (fullText.trim().length > 0) addSpeechLine(`assistant> ${fullText}`);
		const err = event.message.errorMessage;
		if (err) addSpeechLine(`[error] ${err}`);

		// Flush any remaining text if LLM ended mid-speak
		if (ttsInsideSpeak) {
			if (speechStreamText.trim()) {
				audioPlayer?.sendTextChunk(speechStreamText);
				ttsSpeakAccum += speechStreamText;
			}
			const spokenText = ttsSpeakAccum;
			const claimP = ttsSpeakClaimPromise;
			ttsSpeakClaimPromise = null;
			if (spokenText.trim()) {
				addSpeechLine(`[speak] ${spokenText.slice(0, 80)}`);
				const flushP = audioPlayer?.flushStream({ trimMs: playbackTrimMs });
				(claimP || Promise.resolve(true)).then(async (claimed) => {
					if (!claimed) { audioPlayer?.interrupt(); return; }
					await (flushP || Promise.resolve());
					postSpeechToServer(spokenText);
					if (playbackTrimMs > 0) await sleep(playbackTrimMs);
					releaseSpeaking();
				});
			} else {
				audioPlayer?.flushStream();
				if (claimP) claimP.then(claimed => { if (claimed) releaseSpeaking(); });
			}
		}
		speechStreamText = "";
		ttsInsideSpeak = false;
		ttsSpeakAccum = "";
		ttsSpeakClaimPromise = null;

		const intents = extractIntents(fullText);
		if (intents.length > 0) speechIntentBuffer.push(...intents);

		state.speechLiveLine = "";
		state.speechPinnedUser = "";
		tui.requestRender();
	}
	if (event.type === "turn_end") {
		if (speechIntentBuffer.length > 0) {
			const intents = speechIntentBuffer.splice(0);
			injectSpeechForAction(intents);
			if (!state.actionBusy) void runActionContinue();
		}
	}
});

actionAgent.subscribe((event) => {
	persistActionConversation();
	if (event.type === "message_start" && event.message.role === "assistant") {
		actionSawDelta = false;
		actionStreamText = "";
		state.actionLiveLine = "assistant>";
		tui.requestRender();
		return;
	}
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		actionSawDelta = true;
		state.actionLiveLine += event.assistantMessageEvent.delta;
		actionStreamText += event.assistantMessageEvent.delta;

		// Extract any complete <step> tags from the stream so far
		const activities = extractActivities(actionStreamText);
		if (activities.length > 0) {
			actionStreamText = actionStreamText.replace(/<step>[\s\S]*?<\/step>/g, "");
			injectActionForSpeech(activities);
			lastActionActivityAt = Date.now();
			if (!state.speechBusy) void runSpeechContinue();
		}

		tui.requestRender();
		return;
	}
	if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_end") {
		const tc = event.assistantMessageEvent.toolCall;
		addActionLine(`[tool] ${tc.name}(${JSON.stringify(tc.arguments)})`);
	}
	if (event.type === "message_end" && event.message.role === "assistant") {
		const txt = event.message.content.filter((c) => c.type === "text").map((c) => c.text).join("").trim();
		if (txt) addActionLine(`assistant> ${txt}`);
		state.actionLiveLine = "";
		state.actionPinnedUser = "";
		tui.requestRender();
	}
});

async function handleCommand(line) {
	if (line === "/quit" || line === "/exit") {
		isClosing = true;
		speechPollActive = false;
		audioPlayer?.close();
		persistSpeechConversation();
		persistActionConversation();
		tui.stop();
		process.exit(0);
		return;
	}
	if (line === "/reset") {
		if (state.speechBusy) speechAgent.abort();
		if (state.actionBusy) actionAgent.abort();
		speechAgent.reset();
		actionAgent.reset();
		speechAgent.setSystemPrompt(speechSystemPrompt);
		actionAgent.setSystemPrompt(buildActionSystemPrompt());
		lastObservation = null;
		actionStreamText = "";
		lastActionActivityAt = 0;
		stopActionIdleTimer();
		speechIntentBuffer = [];
		addSpeechLine("Context cleared.");
		return;
	}
	if (line === "/session") {
		addActionLine(`session=${worldSession}`);
		return;
	}
	if (line === "/observe status") {
		addSpeechLine(`observe=${observeLoopEnabled ? "on" : "off"} interval=${observeIntervalMs}ms session=${worldSession ? "set" : "missing"}`);
		return;
	}
	if (line === "/observe on") {
		if (!observeLoopEnabled) startObserveLoop();
		addSpeechLine(`observe=on (${observeIntervalMs}ms)`);
		return;
	}
	if (line === "/observe off") {
		observeLoopEnabled = false;
		stopObserveLoop();
		addSpeechLine("observe=off");
		return;
	}
	if (line === "/observe once") {
		try {
			const obs = await fetchObserve();
			if (obs) {
				injectObserveForSpeech(obs);
				if (!state.speechBusy && speechAgent.state.messages.length > 0) void runSpeechContinue();
				addSpeechLine("observe=once queued");
			}
		} catch (error) {
			addSpeechLine(`[observe] error: ${error instanceof Error ? error.message : String(error)}`);
		}
		return;
	}
	if (line.startsWith("/a ")) {
		const text = line.slice(3).trim();
		if (!text) return;
		state.actionPinnedUser = `you> ${text}`;
		addActionLine(`you> ${text}`);
		if (state.actionBusy) {
			addActionLine("Still processing previous request.");
			return;
		}
		void runActionPrompt(text);
		return;
	}
	if (line === "/a") {
		addActionLine("Usage: /a <message>");
		return;
	}
	if (line.startsWith("/s ")) {
		const text = line.slice(3).trim();
		if (!text) return;
		state.speechPinnedUser = `you> ${text}`;
		addSpeechLine(`you> ${text}`);
		if (state.speechBusy) {
			speechAgent.steer({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
			addSpeechLine("Queued steer message.");
			return;
		}
		const userMessage = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
		if (speechAgent.state.messages.length === 0) {
			speechAgent.appendMessage(userMessage);
		} else {
			speechAgent.steer(userMessage);
		}
		void runSpeechContinue();
		return;
	}
	if (line === "/s") {
		addSpeechLine("Usage: /s <message>");
		return;
	}

	if (state.speechBusy) {
		state.speechPinnedUser = `you> ${line}`;
		addSpeechLine(`you> ${line}`);
		speechAgent.steer({ role: "user", content: [{ type: "text", text: line }], timestamp: Date.now() });
		addSpeechLine("Queued steer message.");
		return;
	}

	state.speechPinnedUser = `you> ${line}`;
	addSpeechLine(`you> ${line}`);
	const userMessage = { role: "user", content: [{ type: "text", text: line }], timestamp: Date.now() };
	if (speechAgent.state.messages.length === 0) {
		speechAgent.appendMessage(userMessage);
	} else {
		speechAgent.steer(userMessage);
	}
	void runSpeechContinue();
}

tui.addChild(split);
tui.addChild(inputBox);
tui.setFocus(inputBox);

inputBox.onSubmit = (value) => {
	const line = value.trim();
	inputBox.setValue("");
	if (!line) {
		tui.requestRender();
		return;
	}
	void handleCommand(line);
};

process.on("SIGINT", () => {
	if (state.speechBusy || state.actionBusy) {
		speechAgent.abort();
		actionAgent.abort();
		state.speechBusy = false;
		state.actionBusy = false;
		addSpeechLine("Aborted.");
		return;
	}
	void handleCommand("/quit");
});

addActionLine(`Dual-agent ready with model "${modelName}" (${modelProvider}).`);
addActionLine(`World joined: ${worldBaseUrl} agent=${worldAgentName}`);
addActionLine(`Session key: ${worldSession}`);
addSpeechLine("Commands: /reset, /quit, /session, /observe on|off|status|once, /a <msg>, /s <msg> (plain text goes to speech)");
if (disableSpeechAgent) {
	addSpeechLine("Speech agent disabled (--no-speech).");
}
if (disableActionAgent) {
	addActionLine("Action agent disabled (--no-action).");
}
if (audioPlayer) {
	audioPlayer
		.start()
		.then(() => {
			addSpeechLine(`ElevenLabs multi-context TTS enabled (voice=${elevenLabsVoiceId}, audio=${audioPlayer.audioUrl}).`);
		})
		.catch((err) => addSpeechLine(`[audio] failed to start: ${err instanceof Error ? err.message : String(err)}`));
} else {
	addSpeechLine("ElevenLabs audio disabled (set ELEVENLABS_API_KEY + voice_id in config.json).");
}

// startObserveLoop();  // Disabled: speech agent now receives observations via action agent tool call injection
void speechPollLoop();

tui.start();

if (!disableActionAgent) void runActionPrompt("Fetch the skill commands and observe the world.");
if (!disableSpeechAgent) void runSpeechPrompt(agentConfig.initial_prompt || "You have just woken up in the world.");
