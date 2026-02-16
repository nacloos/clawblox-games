import { Agent } from "/home/nacloos/Code/pi-mono/packages/agent/dist/index.js";
import { getModel } from "/home/nacloos/Code/pi-mono/packages/ai/dist/index.js";
import { createCodingTools } from "/home/nacloos/Code/pi-mono/packages/coding-agent/dist/index.js";
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

function extractActions(text) {
	const out = [];
	const re = /<action>([\s\S]*?)<\/action>/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		const raw = m[1].trim();
		if (!raw) continue;
		try {
			const action = JSON.parse(raw);
			if (action && typeof action.type === "string") out.push(action);
		} catch {
			// Ignore malformed action blocks; keep streaming behavior resilient.
		}
	}
	return out;
}

// Sentence-boundary punctuation and limits for incremental TTS chunking.
const _TTS_PUNCT = [".", "!", "?", "\n", ":", ";"];
const _TTS_MIN_SENTENCE_CHARS = 24;
const _TTS_MAX_BUFFER_CHARS = 80;
const AUDIO_SAMPLE_RATE_HZ = 24000;
const AUDIO_CHANNELS = 1;
const AUDIO_BYTES_PER_SAMPLE = 2;

function base64DecodedLen(data) {
	if (!data || typeof data !== "string") return 0;
	const len = data.length;
	if (len === 0 || len % 4 !== 0) return 0;
	let pad = 0;
	if (data.endsWith("==")) pad = 2;
	else if (data.endsWith("=")) pad = 1;
	return (len / 4) * 3 - pad;
}

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
			this.contextStates = new Map(); // contextId -> { chunkCount, lastChunkTime, doneSent, resolve, receivedFinal }
		this.keepAliveTimer = null;
		this.reconnectDelay = 1000;
		// Streaming text state: accumulates LLM deltas, flushes at sentence boundaries
		this._streamingCtx = null; // contextId for current streaming session
		this._streamingBuffer = ""; // unflushed text
		// Per-stream upload chains enforce strict chunk ordering (including done=true).
		this._uploadChains = new Map(); // streamId -> Promise
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
				ctxState.totalAudioBytes += base64DecodedLen(data.audio);
				if (!ctxState.playbackStartTime) ctxState.playbackStartTime = Date.now();
				debugLog(`WS chunk #${ctxState.chunkCount} ctx=${contextId} audioLen=${data.audio.length}`);
				void this._queueSendChunk(contextId, ctxState.chunkCount - 1, data.audio, false);
			} else {
				debugLog(`WS chunk for unknown/done ctx=${contextId}, ignoring`);
			}
		}

		if (data.isFinal || data.is_final) {
			let finalContextId = contextId;
			if (!finalContextId) {
				if (this.currentContextId && this.contextStates.has(this.currentContextId)) {
					finalContextId = this.currentContextId;
				} else if (this.contextStates.size === 1) {
					for (const onlyId of this.contextStates.keys()) {
						finalContextId = onlyId;
					}
				}
			}
			debugLog(`WS is_final observed ctx=${finalContextId || "(none)"}`);
			if (finalContextId) this._completeContext(finalContextId);
		}

		if (data.error || data.message) {
			const errMsg = data.error || data.message;
			debugLog(`ElevenLabs error: ${errMsg}`);
			this.onError(`[audio] ${errMsg}`);
		} else if (!data.audio && !data.isFinal && !data.is_final) {
			debugLog(`WS unknown msg keys=${Object.keys(data).join(",")}`);
		}
	}

	_completeContext(contextId, speechText) {
		const ctxState = this.contextStates.get(contextId);
		if (!ctxState || ctxState.doneSent) return;
		const finalSpeechText = typeof speechText === "string"
			? speechText
			: (typeof ctxState.finalSpeechText === "string" ? ctxState.finalSpeechText : "");
		ctxState.doneSent = true;
		void this._queueSendChunk(contextId, ctxState.chunkCount, "", true, finalSpeechText)
			.finally(() => {
				if (ctxState.resolve) ctxState.resolve();
				if (this.currentContextId === contextId) this.currentContextId = null;
			});
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

	/** Pre-set the context ID for the next streaming context (used to correlate with SpeechBus Claim). */
	setNextContextId(id) {
		this._pendingContextId = id;
	}

	/** Send a text chunk from the LLM stream. Accumulates and sends at sentence boundaries. */
	sendTextChunk(chunk) {
		if (this.closed || !this.wsReady || !chunk) return;
		// Open a new context on first chunk
		if (!this._streamingCtx) {
			const contextId = this._pendingContextId || `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
			this._pendingContextId = null;
			this._streamingCtx = contextId;
			this._streamingBuffer = "";
			this.currentContextId = contextId;
				const ctxState = {
					chunkCount: 0,
					lastChunkTime: 0,
					doneSent: false,
					resolve: null,
					totalAudioBytes: 0,
					playbackStartTime: 0,
					receivedFinal: false,
					finalSpeechText: "",
				};
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
	async flushStream({ speechText } = {}) {
		const contextId = this._streamingCtx;
		if (!contextId) {
			return {
				totalAudioBytes: 0,
				sampleRateHz: AUDIO_SAMPLE_RATE_HZ,
				channels: AUDIO_CHANNELS,
				bytesPerSample: AUDIO_BYTES_PER_SAMPLE,
				playbackSpeed: this.speed,
			};
		}
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

		if (!ctxState) {
			return {
				totalAudioBytes: 0,
				sampleRateHz: AUDIO_SAMPLE_RATE_HZ,
				channels: AUDIO_CHANNELS,
				bytesPerSample: AUDIO_BYTES_PER_SAMPLE,
				playbackSpeed: this.speed,
			};
		}

		// ElevenLabs recommends explicit context lifecycle control.
		// Close context at end of turn, but only complete when upstream signals is_final.
		ctxState.finalSpeechText = typeof speechText === "string" ? speechText : "";
		this._wsSend({ context_id: contextId, close_context: true });
		debugLog(`flushStream: close_context ctx=${contextId}`);
		const done = new Promise((resolve) => { ctxState.resolve = resolve; });
		await done;
		debugLog(`flushStream: completed ctx=${contextId}`);

		const meta = {
			totalAudioBytes: ctxState.totalAudioBytes || 0,
			sampleRateHz: AUDIO_SAMPLE_RATE_HZ,
			channels: AUDIO_CHANNELS,
			bytesPerSample: AUDIO_BYTES_PER_SAMPLE,
			playbackSpeed: this.speed,
		};
		this.contextStates.delete(contextId);
		return meta;
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

	_queueSendChunk(streamId, seq, data, done, speechText) {
		const prev = this._uploadChains.get(streamId) || Promise.resolve();
		const next = prev
			.catch(() => {})
			.then(() => this._sendChunk(streamId, seq, data, done, speechText))
			.catch((err) => {
				debugLog(`sendChunk error stream=${streamId} seq=${seq} done=${done}: ${err instanceof Error ? err.message : String(err)}`);
			});
		this._uploadChains.set(streamId, next);
		next.finally(() => {
			if (this._uploadChains.get(streamId) === next) {
				this._uploadChains.delete(streamId);
			}
		});
		return next;
	}

	async _sendChunk(streamId, seq, data, done, speechText) {
		const body = {
			stream_id: streamId,
			seq,
			data,
			done,
			sample_rate_hz: AUDIO_SAMPLE_RATE_HZ,
			channels: AUDIO_CHANNELS,
			bytes_per_sample: AUDIO_BYTES_PER_SAMPLE,
			playback_speed: this.speed,
		};
		if (done && speechText) body.speech_text = speechText;
		const res = await fetch(this.audioUrl, {
			method: "POST",
			headers: {
				"X-Session": this.sessionToken,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${res.statusText}`);
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
		} catch (err) {
			debugLog(`loadCodexAccessToken parse error at ${p}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return undefined;
}

let debugLogPath; // set after gameDir/agentName is resolved
let debugLogPrefix = "";
function debugLog(msg) {
	if (debugLogPath) appendFileSync(debugLogPath, `[${new Date().toISOString()}]${debugLogPrefix} ${msg}\n`);
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

function buildSpectateWsUrl(baseUrl, role = "spectator") {
	const url = new URL(baseUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = "/spectate/ws";
	url.search = `role=${encodeURIComponent(role)}`;
	url.hash = "";
	return url.toString();
}

loadDotEnvFromCwdAndParents();

const argv = process.argv.slice(2);
const cliFlags = new Set(argv.filter((a) => a.startsWith("--") && !a.includes("=")));
const cliNameArg = argv.find((a) => a.startsWith("--name="))?.split("=")[1]
	|| argv[argv.indexOf("--name") + 1];
const cliDir = argv.find((a) => a.startsWith("--dir="))?.split("=")[1]
	|| argv[argv.indexOf("--dir") + 1];

const scriptPath = new URL(import.meta.url).pathname;
const scriptDir = path.dirname(scriptPath);
const gameDir = cliDir ? path.resolve(cliDir) : scriptDir;
const scriptName = path.basename(scriptPath, path.extname(scriptPath));
const agentName = cliNameArg || process.env.WORLD_AGENT_NAME || scriptName;
const logsDir = path.join(gameDir, "logs");
mkdirSync(logsDir, { recursive: true });
debugLogPath = process.env.DEBUG_LOG_PATH || path.join(logsDir, `${agentName}.debug.log`);
debugLogPrefix = ` [agent=${agentName} pid=${process.pid}]`;
writeFileSync(debugLogPath, ""); // clear this agent's debug log on start
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
const SHARED_CONTEXT_FILES = new Set(["SOUL.md"]);
function listMdFiles(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith(".md"));
}
const allContextFiles = [...new Set([...listMdFiles(defaultTemplateDir), ...listMdFiles(agentTemplateDir)])];
const contextFiles = allContextFiles.filter((file) => !SHARED_CONTEXT_FILES.has(file));
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
let worldSession = "";
let worldAgentId = "";
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
	const sharedSoulPath = path.join(defaultTemplateDir, "SOUL.md");
	const sharedSoul = existsSync(sharedSoulPath) ? readFileSync(sharedSoulPath, "utf8").trim() : "";
	lines.push(
		"## Workspace",
		"",
		`Your workspace is ${agentDir}. Only work inside this directory.`,
		"Be polite and avoid working on your memory files when interacting with someone else.",
		"",
		"# Project Context",
		"",
		"SOUL.md is shared globally across all agents from templates/agent/SOUL.md.",
		"All other memory files below are agent-local workspace files.",
		"",
	);
	if (sharedSoul) {
		lines.push("---", "", `**SOUL.md** (${sharedSoulPath})`, "", sharedSoul, "");
	}
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
		"You receive speech from other players and can react naturally.",
		"Don't mention low level details like coordinates, this is fucking boring.",
		"To take a world action, output a JSON payload inside <action>...</action> tags.",
		"Use one action object per <action> tag, with {\"type\":\"...\",\"data\":{...}} format.",
		"Only use action types and data shapes defined by the current game's skill.md.",
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

const disableActionAgent = true;
const disableSpeechAgent = cliFlags.has("--no-speech");
const disableAudio = cliFlags.has("--no-audio");

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
let speechStreamText = "";
let ttsInsideSpeak = false; // true while accumulating text inside <speak>/<s> tag
let ttsSpeakAccum = ""; // full text of current speak segment (for speech channel + logging)
let ttsSpeakStreamId = null; // stream_id for SpeechBus claim of current speak segment
let ttsSpeakLeaseId = null; // lease_id granted by server for current stream
let ttsCanStream = false; // true only after SpeechBus claim confirmed
let ttsPendingText = ""; // buffered speak text while claim is pending
let ttsClaimPromise = null; // promise resolving to claim result for current stream
let ttsHeartbeatTimer = null;
let ttsHeartbeatSeq = 0;
let ttsProgressSeq = 0;
let ttsLastProgressSentText = "";
let ttsLastProgressSentAt = 0;
let speechEventEpoch = 0; // increments on each heard-other speech event

function startActionIdleTimer() {
	stopActionIdleTimer();
	actionIdleTimer = setInterval(() => {
		if (!state.actionBusy || isClosing) return;
		if (Date.now() - lastActionActivityAt < ACTION_IDLE_MS) return;
		lastActionActivityAt = Date.now();
		injectActionForSpeech([{ action: "still working...", observation: "" }]);
		if (!state.speechBusy) void runSpeechContinue("action_idle_timer");
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
	!disableAudio && elevenLabsApiKey && elevenLabsVoiceId
		? new ElevenLabsMultiContextPlayer({
				apiKey: elevenLabsApiKey,
				voiceId: elevenLabsVoiceId,
				modelId: elevenLabsModelId,
				audioUrl: `${worldBaseUrl}/audio`,
				sessionToken: worldSession,
				onError: (msg) => addSpeechLine(msg),
			})
		: null;

function requestRender() {}

function trimBuffer(arr, max = 200) {
	if (arr.length > max) arr.splice(0, arr.length - max);
}

function addSpeechLine(text) {
	const line = `[${now()}] [speech] ${text}`;
	state.speechLines.push(line);
	trimBuffer(state.speechLines);
	console.log(line);
	requestRender();
}

function addActionLine(text) {
	const line = `[${now()}] [action] ${text}`;
	state.actionLines.push(line);
	trimBuffer(state.actionLines);
	console.log(line);
	requestRender();
}

function persistSpeechConversation() {
	writeFileSync(speechConversationPath, JSON.stringify(speechAgent.state.messages, null, 2));
}

function persistActionConversation() {
	writeFileSync(actionConversationPath, JSON.stringify(actionAgent.state.messages, null, 2));
}

function getGameStateAttributesFromObservation(observation) {
	const entities = Array.isArray(observation?.world?.entities) ? observation.world.entities : [];
	for (const entity of entities) {
		if (entity?.name !== "GameState") continue;
		const attrs = entity?.attributes;
		if (attrs && typeof attrs === "object") return attrs;
		return {};
	}
	return null;
}

function getCurrentSpeakerFromObservation(observation) {
	const attrs = getGameStateAttributesFromObservation(observation);
	if (!attrs) return "";
	return String(attrs.current_speaker || "").trim();
}

function isSpeechTurnBlocked() {
	const speaker = getCurrentSpeakerFromObservation(lastObservation);
	return Boolean(speaker) && speaker !== worldAgentName;
}

function isSpeechPipelineBusy() {
	return state.speechBusy || Boolean(ttsClaimPromise) || Boolean(ttsSpeakStreamId) || ttsInsideSpeak;
}

async function runSpeechPrompt(text, source = "unspecified") {
	const pipelineBusy = isSpeechPipelineBusy();
	debugLog(`[speech] prompt requested source=${source} busy=${pipelineBusy} closing=${isClosing}`);
	if (disableSpeechAgent || isClosing || pipelineBusy) return;
	if (isSpeechTurnBlocked()) {
		debugLog(`[speech] prompt blocked source=${source} current_speaker=${getCurrentSpeakerFromObservation(lastObservation)}`);
		return;
	}
	state.speechBusy = true;
	requestRender();
	try {
		debugLog(`[speech] prompt start source=${source}`);
		await speechAgent.prompt(text);
	} catch (error) {
		addSpeechLine(`[error] ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		state.speechBusy = false;
		debugLog(`[speech] prompt end source=${source}`);
		requestRender();
	}
}

async function runSpeechContinue(source = "unspecified") {
	const pipelineBusy = isSpeechPipelineBusy();
	debugLog(`[speech] continue requested source=${source} busy=${pipelineBusy} closing=${isClosing}`);
	if (disableSpeechAgent || isClosing || pipelineBusy) return;
	if (isSpeechTurnBlocked()) {
		debugLog(`[speech] continue blocked source=${source} current_speaker=${getCurrentSpeakerFromObservation(lastObservation)}`);
		return;
	}
	state.speechBusy = true;
	requestRender();
	try {
		debugLog(`[speech] continue start source=${source}`);
		await speechAgent.continue();
	} catch (error) {
		addSpeechLine(`[error] ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		state.speechBusy = false;
		debugLog(`[speech] continue end source=${source}`);
		requestRender();
	}
}

async function runActionContinue() {
	if (disableActionAgent || isClosing || state.actionBusy) return;
	state.actionBusy = true;
	actionSawDelta = false;
	state.actionLiveLine = "";
	lastActionActivityAt = Date.now();
	startActionIdleTimer();
	requestRender();
	try {
		await actionAgent.continue();
	} catch (error) {
		addActionLine(`[error] ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		state.actionBusy = false;
		state.actionLiveLine = "";
		stopActionIdleTimer();
		requestRender();
	}
}

async function runActionPrompt(text) {
	if (disableActionAgent || isClosing || state.actionBusy) return;
	state.actionBusy = true;
	actionSawDelta = false;
	state.actionLiveLine = "";
	lastActionActivityAt = Date.now();
	startActionIdleTimer();
	requestRender();
	try {
		await actionAgent.prompt(text);
	} catch (error) {
		addActionLine(`[error] ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		state.actionBusy = false;
		state.actionLiveLine = "";
		stopActionIdleTimer();
		requestRender();
	}
}

async function fetchObserve() {
	if (!worldSession) return null;
	return await fetchJson(`${worldBaseUrl}/observe`, {
		method: "GET",
		headers: { "X-Session": worldSession },
	});
}

async function sendWorldInput(inputType, data = {}) {
	const res = await fetch(`${worldBaseUrl}/input`, {
		method: "POST",
		headers: { "X-Session": worldSession, "Content-Type": "application/json" },
		body: JSON.stringify({ type: inputType, data }),
	});
	if (!res.ok) throw new Error(`${inputType} failed: ${res.status} ${res.statusText}`);
	return await res.json();
}

async function sendSpeechBus(op, payload = {}) {
	return await sendWorldInput("RemoteEvent", {
		name: "SpeechBus",
		args: [{ op, ...payload }],
	});
}

function getSpeechLeaseFromObservation(observation, streamId) {
	if (!observation) return { claimed: false, leaseId: null };
	const attrs = observation?.player?.attributes || {};
	const speaker = getCurrentSpeakerFromObservation(observation);
	const claimedBySelf = attrs?.IsSpeaking === true || speaker === worldAgentName;
	if (!claimedBySelf) return { claimed: false, leaseId: null };
	const observedStreamId = String(attrs?.SpeechStreamId || "").trim();
	const observedLeaseId = String(attrs?.SpeechLeaseId || "").trim();
	if (!observedLeaseId) return { claimed: false, leaseId: null };
	if (observedStreamId && observedStreamId !== streamId) return { claimed: false, leaseId: null };
	return { claimed: true, leaseId: observedLeaseId };
}

async function sendSpeechClaim(streamId) {
	const obs = await sendSpeechBus("Claim", { stream_id: streamId });
	let claim = getSpeechLeaseFromObservation(obs, streamId);
	// Observation snapshots can lag by a tick; retry once before treating as rejected.
	if (!claim.claimed) {
		try {
			await sleep(80);
			const retryObs = await fetchObserve();
			claim = getSpeechLeaseFromObservation(retryObs, streamId);
		} catch (err) {
			debugLog(`sendSpeechClaim retry observe error for ${streamId}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (!claim.claimed) {
		debugLog(`sendSpeechClaim: claim rejected for stream ${streamId}`);
	}
	return claim;
}

async function sendSpeechClaimWithRetry(
	streamId,
	{ retryDelayMs = SPEECH_CLAIM_RETRY_DELAY_MS, shouldAbort = null } = {},
) {
	while (!isClosing) {
		if (typeof shouldAbort === "function" && shouldAbort()) {
			// Before aborting as stale, check whether server already granted this stream.
			// This avoids dropping a just-granted lease during lock handoff races.
			try {
				const obs = await fetchObserve();
				const claim = getSpeechLeaseFromObservation(obs, streamId);
				if (claim.claimed && claim.leaseId) {
					debugLog(`sendSpeechClaimWithRetry: recovered granted lease for stale stream ${streamId}`);
					return claim.leaseId;
				}
			} catch (err) {
				debugLog(`sendSpeechClaimWithRetry stale-check observe error for ${streamId}: ${err instanceof Error ? err.message : String(err)}`);
			}
			debugLog(`sendSpeechClaimWithRetry: abort stale stream ${streamId}`);
			return null;
		}
		try {
			const claim = await sendSpeechClaim(streamId);
			if (claim.claimed && claim.leaseId) return claim.leaseId;
		} catch (err) {
			debugLog(`sendSpeechClaimWithRetry error for ${streamId}: ${err instanceof Error ? err.message : String(err)}`);
		}
		await sleep(retryDelayMs);
	}
	debugLog(`sendSpeechClaimWithRetry: aborted due to shutdown for stream ${streamId}`);
	return null;
}

async function sendSpeechHeartbeat(streamId, leaseId, progressSeq) {
	try {
		await sendSpeechBus("Heartbeat", {
			stream_id: streamId,
			lease_id: leaseId,
			progress_seq: Number(progressSeq || 0),
		});
	} catch (err) {
		debugLog(`sendSpeechHeartbeat error for ${streamId}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function sendSpeechProgress(streamId, leaseId, progressSeq, text) {
	try {
		await sendSpeechBus("Progress", {
			stream_id: streamId,
			lease_id: leaseId,
			progress_seq: Number(progressSeq || 0),
			text: String(text || ""),
		});
	} catch (err) {
		debugLog(`sendSpeechProgress error for ${streamId}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function sendSpeechCancel(streamId, leaseId = null) {
	try {
		const payload = { stream_id: streamId };
		if (leaseId) payload.lease_id = leaseId;
		await sendSpeechBus("Cancel", payload);
	} catch (err) {
		debugLog(`sendSpeechCancel error for ${streamId}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function sendSpeechFinalize(streamId, leaseId, speechText, playbackMeta = {}) {
	try {
		await sendSpeechBus("Finalize", {
			stream_id: streamId,
			lease_id: leaseId,
			speech_text: speechText || "",
			total_audio_bytes: Number(playbackMeta.totalAudioBytes || 0),
			sample_rate_hz: Number(playbackMeta.sampleRateHz || AUDIO_SAMPLE_RATE_HZ),
			channels: Number(playbackMeta.channels || AUDIO_CHANNELS),
			bytes_per_sample: Number(playbackMeta.bytesPerSample || AUDIO_BYTES_PER_SAMPLE),
			playback_speed: Number(playbackMeta.playbackSpeed || 1.0),
		});
		debugLog(`sendSpeechFinalize: stream=${streamId} lease=${leaseId || "(none)"} bytes=${Number(playbackMeta.totalAudioBytes || 0)}`);
	} catch (err) {
		debugLog(`sendSpeechFinalize error for ${streamId}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function stopSpeechHeartbeat() {
	if (ttsHeartbeatTimer) {
		clearInterval(ttsHeartbeatTimer);
		ttsHeartbeatTimer = null;
	}
}

function startSpeechHeartbeat(streamId, leaseId) {
	stopSpeechHeartbeat();
	ttsHeartbeatSeq = 0;
	const send = () => {
		if (!ttsSpeakStreamId || ttsSpeakStreamId !== streamId) return;
		if (!ttsSpeakLeaseId || ttsSpeakLeaseId !== leaseId) return;
		ttsHeartbeatSeq += 1;
		void sendSpeechHeartbeat(streamId, leaseId, ttsHeartbeatSeq);
	};
	send();
	ttsHeartbeatTimer = setInterval(send, 800);
}

function resetTtsSpeechState() {
	speechStreamText = "";
	ttsInsideSpeak = false;
	ttsSpeakAccum = "";
	ttsSpeakStreamId = null;
	ttsSpeakLeaseId = null;
	ttsCanStream = false;
	ttsPendingText = "";
	ttsClaimPromise = null;
	ttsProgressSeq = 0;
	ttsLastProgressSentText = "";
	ttsLastProgressSentAt = 0;
	stopSpeechHeartbeat();
}

function cancelPendingSpeechStream(reason = "unknown") {
	const streamId = ttsSpeakStreamId;
	if (!streamId) return;
	const leaseId = ttsSpeakLeaseId || null;
	debugLog(`[speech] cancel pending stream=${streamId} lease=${leaseId || "(none)"} reason=${reason}`);
	resetTtsSpeechState();
	audioPlayer?.interrupt();
	if (leaseId) void sendSpeechCancel(streamId, leaseId);
	else debugLog(`[speech] cancel skipped stream=${streamId} reason=no_lease`);
}

function maybeSendSpeechProgress(force = false) {
	if (!ttsCanStream || !ttsSpeakStreamId || !ttsSpeakLeaseId) return;
	const text = String(ttsSpeakAccum || "");
	if (!text.trim()) return;
	const nowMs = Date.now();
	if (!force && text === ttsLastProgressSentText && nowMs - ttsLastProgressSentAt < SPEECH_PROGRESS_MIN_INTERVAL_MS) {
		return;
	}
	if (!force && nowMs - ttsLastProgressSentAt < SPEECH_PROGRESS_MIN_INTERVAL_MS) {
		return;
	}
	ttsProgressSeq += 1;
	ttsLastProgressSentText = text;
	ttsLastProgressSentAt = nowMs;
	void sendSpeechProgress(ttsSpeakStreamId, ttsSpeakLeaseId, ttsProgressSeq, text);
}

async function executeActions(actions) {
	for (const action of actions) {
		const actionType = action?.type;
		if (!actionType || actionType === "PlaySpeech") continue;
		try {
			await sendWorldInput(actionType, action?.data ?? {});
			addSpeechLine(`[action] ${actionType}`);
		} catch (error) {
			addSpeechLine(`[action error] ${actionType}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
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

let speechWs = null;
let speechWsActive = false;
let speechWsReconnectTimer = null;
let speechLastSeq = 0;
const playbackDoneWaiters = new Map(); // stream_id -> { resolve }
const completedPlaybackStreams = new Map(); // stream_id -> playback_done payload
const pendingSpeechEvents = [];
const STALL_CUE_TEXT = process.env.STALL_CUE_TEXT || "[scene cue]: Everyone stays silent for a moment. The pause turns awkward.";
const SERVER_SILENCE_REPEAT_MS = Number(process.env.SERVER_SILENCE_REPEAT_MS || "2000");
const ENABLE_SERVER_SILENCE_CUE = process.env.ENABLE_SERVER_SILENCE_CUE === "1";
const SPEECH_CLAIM_RETRY_DELAY_MS = Number(process.env.SPEECH_CLAIM_RETRY_DELAY_MS || "180");
const SPEECH_PROGRESS_MIN_INTERVAL_MS = Number(process.env.SPEECH_PROGRESS_MIN_INTERVAL_MS || "120");
let lastConversationActivityAt = Date.now();
let lastServerSilenceEpochHandled = 0;
let lastServerSilenceCueAt = 0;
let stallCueTimer = null;
let stallCueObserveInFlight = false;
let lastStallSkipReason = "";
let lastStallSkipLogAt = 0;

function markConversationActivity(source) {
	lastConversationActivityAt = Date.now();
	debugLog(`[stall] activity source=${source}`);
}

function logStallSkip(reason, nowMs = Date.now()) {
	// Keep logs readable while still exposing timing/gating decisions.
	if (reason !== lastStallSkipReason || nowMs - lastStallSkipLogAt > 2000) {
		lastStallSkipReason = reason;
		lastStallSkipLogAt = nowMs;
		debugLog(`[stall] skip reason=${reason}`);
	}
}

function scheduleSpeechWsReconnect() {
	if (!speechWsActive || isClosing || speechWsReconnectTimer) return;
	speechWsReconnectTimer = setTimeout(() => {
		speechWsReconnectTimer = null;
		connectSpeechWs();
	}, 1000);
}

function flushDeferredSpeechEvents() {
	if (pendingSpeechEvents.length === 0) return;
	const currentSpeaker = getCurrentSpeakerFromObservation(lastObservation);
	if (currentSpeaker && currentSpeaker !== worldAgentName) return;
	while (pendingSpeechEvents.length > 0) {
		const ev = pendingSpeechEvents.shift();
		addSpeechLine(`[heard] ${ev.speaker}: ${ev.text}`);
		speechAgent.steer({
			role: "user",
			content: [{ type: "text", text: `[${ev.speaker} says]: ${ev.text}` }],
			timestamp: Date.now(),
		});
	}
		if (!isSpeechPipelineBusy()) void runSpeechContinue("flushDeferredSpeechEvents");
}

function handleSpeechEvent(ev) {
	if (!ev || ev.type !== "speech") return;
	const seq = Number(ev.seq);
	if (Number.isFinite(seq) && seq > 0) {
		if (seq <= speechLastSeq) return;
		speechLastSeq = seq;
	}
	if (ev.speaker === worldAgentName) {
		// Ignore own speech events for stall timing.
		// Self timing is anchored strictly to explicit playback_done WS events.
		return;
	}
	speechEventEpoch += 1;
	if (ttsSpeakStreamId && ttsSpeakLeaseId) {
		// We already hold a lease for a turn and someone else committed speech.
		// Cancel current turn to avoid speaking over newer context.
		cancelPendingSpeechStream(`heard_other_claimed:${ev.speaker}`);
	}
	markConversationActivity(`heard:${ev.speaker}`);
	// Process heard speech immediately. Deferring on speaker lock caused stalls when
	// observation-driven flush did not run, so replies could be blocked indefinitely.
	addSpeechLine(`[heard] ${ev.speaker}: ${ev.text}`);
	speechAgent.steer({
		role: "user",
		content: [{ type: "text", text: `[${ev.speaker} says]: ${ev.text}` }],
		timestamp: Date.now(),
	});
	if (!isSpeechPipelineBusy()) void runSpeechContinue(`heard:${ev.speaker}`);
}

function resolveSelfPlaybackDone(ev) {
	const streamId = String(ev?.stream_id || "").trim();
	if (!streamId) return;
	completedPlaybackStreams.set(streamId, ev || {});
	const waiter = playbackDoneWaiters.get(streamId);
	if (waiter) {
		playbackDoneWaiters.delete(streamId);
		waiter.resolve(ev || {});
	}
}

async function waitForSelfPlaybackDone(streamId) {
	const id = String(streamId || "").trim();
	if (!id) return null;
	const completed = completedPlaybackStreams.get(id);
	if (completed) {
		completedPlaybackStreams.delete(id);
		return completed;
	}
	return await new Promise((resolve) => {
		playbackDoneWaiters.set(id, { resolve });
	});
}

function connectSpeechWs() {
	if (!speechWsActive || isClosing || !worldSession) return;
	const wsUrl = buildSpectateWsUrl(worldBaseUrl, "actor");
	const ws = new WebSocketClient(wsUrl, { headers: { "X-Session": worldSession } });
	speechWs = ws;

	ws.on("open", () => {
		if (speechWs !== ws) return;
		addSpeechLine(`[speech-ws] connected ${wsUrl}`);
	});

	ws.on("message", (raw) => {
		if (speechWs !== ws) return;
		try {
			const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
			const parsed = JSON.parse(text);
				if (parsed?.type === "speech") {
					handleSpeechEvent(parsed);
				} else if (parsed?.type === "playback_done") {
					if (parsed?.speaker === worldAgentName) {
						markConversationActivity(`self_playback_done:${parsed?.stream_id || "unknown"}`);
						resolveSelfPlaybackDone(parsed);
					}
				}
		} catch {
			// Ignore non-JSON / non-speech messages (state snapshots, binary, etc.).
		}
	});

	ws.on("close", () => {
		if (speechWs === ws) speechWs = null;
		if (speechWsActive && !isClosing) scheduleSpeechWsReconnect();
	});

	ws.on("error", (err) => {
		if (speechWs !== ws) return;
		debugLog(`[speech-ws] error: ${err instanceof Error ? err.message : String(err)}`);
	});
}

function startSpeechWsLoop() {
	speechWsActive = true;
	connectSpeechWs();
}

function stopSpeechWsLoop() {
	speechWsActive = false;
	if (speechWsReconnectTimer) {
		clearTimeout(speechWsReconnectTimer);
		speechWsReconnectTimer = null;
	}
	if (speechWs) {
		try {
			speechWs.close();
		} catch (err) {
			debugLog(`[speech-ws] close error: ${err instanceof Error ? err.message : String(err)}`);
		}
		speechWs = null;
	}
}


function startStallCueLoop() {
	if (!ENABLE_SERVER_SILENCE_CUE) {
		debugLog("[stall] server silence cue disabled");
		return;
	}
	stopStallCueLoop();
	stallCueTimer = setInterval(async () => {
		if (isClosing || disableSpeechAgent) {
			logStallSkip(`disabled_or_closing disableSpeech=${disableSpeechAgent} closing=${isClosing}`);
			return;
		}
		if (isSpeechPipelineBusy()) {
			logStallSkip("speech_busy");
			return;
		}
		if (stallCueObserveInFlight) {
			logStallSkip("observe_in_flight");
			return;
		}

		stallCueObserveInFlight = true;
		try {
			const obs = await fetchObserve();
			if (!obs) return;
			lastObservation = obs;
			flushDeferredSpeechEvents();

			const gameStateAttrs = getGameStateAttributesFromObservation(obs);
			if (!gameStateAttrs) {
				logStallSkip("no_game_state");
				return;
			}

			const speaker = String(gameStateAttrs.current_speaker || "").trim();
			if (speaker) {
				logStallSkip(`speaker_locked speaker=${speaker}`);
				return;
			}

			const isGloballySilent = gameStateAttrs.is_globally_silent === true;
			if (!isGloballySilent) {
				logStallSkip("server_not_globally_silent");
				return;
			}

			const epochRaw = Number(gameStateAttrs.silence_epoch || 0);
			const silenceEpoch = Number.isFinite(epochRaw) ? Math.floor(epochRaw) : 0;
			if (silenceEpoch <= 0) {
				logStallSkip(`server_invalid_silence_epoch value=${String(gameStateAttrs.silence_epoch)}`);
				return;
			}

			const nowMs = Date.now();
			const isNewEpoch = silenceEpoch > lastServerSilenceEpochHandled;
			const canRepeat = silenceEpoch == lastServerSilenceEpochHandled
				&& nowMs - lastServerSilenceCueAt >= SERVER_SILENCE_REPEAT_MS;
			if (!isNewEpoch && !canRepeat) {
				const remaining = Math.max(0, SERVER_SILENCE_REPEAT_MS - (nowMs - lastServerSilenceCueAt));
				logStallSkip(`server_silence_repeat_cooldown epoch=${silenceEpoch} remaining=${remaining}ms`);
				return;
			}

			lastServerSilenceEpochHandled = silenceEpoch;
			lastServerSilenceCueAt = nowMs;
			const silenceMs = Number(gameStateAttrs.silence_ms || 0);
			markConversationActivity(`server_silence_epoch:${silenceEpoch}`);
			addSpeechLine(`[stall] injecting server silence cue epoch=${silenceEpoch} silence_ms=${silenceMs}`);
			debugLog(`[stall] inject trigger server_silence epoch=${silenceEpoch} repeat=${isNewEpoch ? "new" : "repeat"} silence_ms=${silenceMs}`);
			speechAgent.steer({
				role: "user",
				content: [{ type: "text", text: STALL_CUE_TEXT }],
				timestamp: nowMs,
			});
			if (!isSpeechPipelineBusy()) void runSpeechContinue(`server_silence_epoch:${silenceEpoch}:${isNewEpoch ? "new" : "repeat"}`);
		} catch (error) {
			debugLog(`[stall] observe error: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			stallCueObserveInFlight = false;
		}
	}, 250);
}

function stopStallCueLoop() {
	if (stallCueTimer) clearInterval(stallCueTimer);
	stallCueTimer = null;
}

speechAgent.subscribe(async (event) => {
	persistSpeechConversation();

		if (event.type === "message_start" && event.message.role === "assistant") {
			stopSpeechHeartbeat();
			speechStreamText = "";
			ttsInsideSpeak = false;
			ttsSpeakAccum = "";
			ttsSpeakStreamId = null;
			ttsSpeakLeaseId = null;
			ttsCanStream = false;
			ttsPendingText = "";
			ttsClaimPromise = null;
			ttsProgressSeq = 0;
			ttsLastProgressSentText = "";
			ttsLastProgressSentAt = 0;
		state.speechLiveLine = "assistant>";
		requestRender();
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
					if (!openMatch) {
						// Keep a short tail so split tags across deltas can still be detected.
						if (speechStreamText.length > 32) {
							speechStreamText = speechStreamText.slice(-32);
						}
						break;
					}
					// Discard everything before and including the opening tag
					speechStreamText = speechStreamText.slice(openMatch.index + openMatch[0].length);
					ttsInsideSpeak = true;
					// Use one stream per assistant message (even with multiple <speak> tags)
					// to avoid overlapping playback between segments.
					if (!ttsSpeakStreamId) {
						ttsSpeakAccum = "";
						ttsPendingText = "";
						ttsCanStream = false;
							const streamId = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
							const streamStartEpoch = speechEventEpoch;
							ttsSpeakStreamId = streamId;
							audioPlayer?.setNextContextId(streamId);
							ttsClaimPromise = sendSpeechClaimWithRetry(streamId, {
								shouldAbort: () => (
									ttsSpeakStreamId !== streamId
									|| streamStartEpoch < speechEventEpoch
								),
							})
								.then((leaseId) => {
									// Ignore stale claim results from old streams.
									if (ttsSpeakStreamId !== streamId) return null;
									ttsCanStream = Boolean(leaseId);
									ttsSpeakLeaseId = leaseId || null;
									if (!leaseId) {
										debugLog(`Speech claim rejected for stream ${streamId}, dropping buffered audio`);
										ttsPendingText = "";
										audioPlayer?.interrupt();
										return null;
									}
									startSpeechHeartbeat(streamId, leaseId);
									if (ttsPendingText) {
										audioPlayer?.sendTextChunk(ttsPendingText);
										ttsPendingText = "";
									}
									maybeSendSpeechProgress();
									return leaseId;
								})
								.catch((err) => {
									if (ttsSpeakStreamId === streamId) {
										debugLog(`sendSpeechClaim error for ${streamId}: ${err instanceof Error ? err.message : String(err)}`);
										ttsCanStream = false;
										ttsSpeakLeaseId = null;
										ttsPendingText = "";
										stopSpeechHeartbeat();
										audioPlayer?.interrupt();
									}
									return null;
								});
					} else if (ttsSpeakAccum.length > 0 && !ttsSpeakAccum.endsWith("\n\n")) {
						// Add a small pause between speak-tag segments while keeping one stream.
						if (ttsCanStream) audioPlayer?.sendTextChunk("\n\n");
						else ttsPendingText += "\n\n";
						ttsSpeakAccum += "\n\n";
						maybeSendSpeechProgress();
					}
				}
				// We're inside a speak tag — look for closing tag
				const closeMatch = speechStreamText.match(/<\/(?:speak|s)>/);
					if (closeMatch) {
						const inner = speechStreamText.slice(0, closeMatch.index);
						if (inner) {
							if (ttsCanStream) audioPlayer?.sendTextChunk(inner);
							else ttsPendingText += inner;
						}
						ttsSpeakAccum += inner;
						maybeSendSpeechProgress();
						speechStreamText = speechStreamText.slice(closeMatch.index + closeMatch[0].length);
						ttsInsideSpeak = false;
					} else {
						// No closing tag yet — send what we have so far as incremental text
						if (speechStreamText.length > 0) {
							if (ttsCanStream) audioPlayer?.sendTextChunk(speechStreamText);
							else ttsPendingText += speechStreamText;
							ttsSpeakAccum += speechStreamText;
							maybeSendSpeechProgress();
						}
						speechStreamText = "";
						break;
					}
				}

			requestRender();
			return;
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
		const fullText = event.message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
		if (fullText.trim().length > 0) addSpeechLine(`assistant> ${fullText}`);
		const err = event.message.errorMessage;
		if (err) addSpeechLine(`[error] ${err}`);

			// Flush any remaining text if LLM ended mid-speak or with buffered speak stream.
				if (ttsSpeakStreamId) {
					const streamId = ttsSpeakStreamId;
					let leaseId = ttsSpeakLeaseId;
					if (ttsClaimPromise) {
						try {
							leaseId = await ttsClaimPromise;
						} catch {
							leaseId = null;
						}
					}
					// Recover late grants that may have landed during epoch/claim races.
					if (!leaseId) {
						try {
							const obs = await fetchObserve();
							const claim = getSpeechLeaseFromObservation(obs, streamId);
							if (claim.claimed && claim.leaseId) {
								leaseId = claim.leaseId;
								ttsCanStream = true;
								ttsSpeakLeaseId = leaseId;
								startSpeechHeartbeat(streamId, leaseId);
								debugLog(`message_end: recovered late lease stream=${streamId}`);
							}
						} catch (err) {
							debugLog(`message_end lease recovery error for ${streamId}: ${err instanceof Error ? err.message : String(err)}`);
						}
					}
					const claimed = Boolean(leaseId);

					if (ttsInsideSpeak && speechStreamText.trim()) {
						if (claimed) audioPlayer?.sendTextChunk(speechStreamText);
						else ttsPendingText += speechStreamText;
					ttsSpeakAccum += speechStreamText;
					maybeSendSpeechProgress();
				}

				if (claimed && ttsPendingText) {
					audioPlayer?.sendTextChunk(ttsPendingText);
					ttsPendingText = "";
				}

					if (claimed) {
						const spokenText = ttsSpeakAccum;
						maybeSendSpeechProgress(true);
						let playbackMeta = {
							totalAudioBytes: 0,
							sampleRateHz: AUDIO_SAMPLE_RATE_HZ,
						channels: AUDIO_CHANNELS,
						bytesPerSample: AUDIO_BYTES_PER_SAMPLE,
						playbackSpeed: 1.0,
					};
					if (audioPlayer) {
						if (spokenText.trim()) {
							playbackMeta = await audioPlayer.flushStream({ speechText: spokenText }) || playbackMeta;
						} else {
							playbackMeta = await audioPlayer.flushStream() || playbackMeta;
						}
					}
						if (spokenText.trim()) {
							markConversationActivity("self_spoke");
							addSpeechLine(`[speak] ${spokenText.slice(0, 80)}`);
						}
						if (audioPlayer) {
							await waitForSelfPlaybackDone(streamId);
						}
						await sendSpeechFinalize(streamId, leaseId, spokenText, playbackMeta);
						stopSpeechHeartbeat();
					} else {
						if (leaseId) await sendSpeechCancel(streamId, leaseId);
						debugLog(`message_end: skipping TTS flush for unclaimed stream ${streamId}`);
						stopSpeechHeartbeat();
					}
				}
			speechStreamText = "";
			ttsInsideSpeak = false;
			ttsSpeakAccum = "";
			ttsSpeakStreamId = null;
			ttsSpeakLeaseId = null;
			ttsCanStream = false;
			ttsPendingText = "";
			ttsClaimPromise = null;
			ttsProgressSeq = 0;
			ttsLastProgressSentText = "";
			ttsLastProgressSentAt = 0;
			stopSpeechHeartbeat();

			const actions = extractActions(fullText);
			if (actions.length > 0) void executeActions(actions);

		state.speechLiveLine = "";
		state.speechPinnedUser = "";
		requestRender();
	}
	});

actionAgent.subscribe((event) => {
	persistActionConversation();
	if (event.type === "message_start" && event.message.role === "assistant") {
		actionSawDelta = false;
		actionStreamText = "";
		state.actionLiveLine = "assistant>";
		requestRender();
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
			if (!state.speechBusy) void runSpeechContinue("action_activity");
		}

		requestRender();
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
		requestRender();
	}
});

async function shutdown(reason = "signal") {
	if (isClosing) return;
	isClosing = true;
	addActionLine(`Shutting down (${reason})...`);

	stopStallCueLoop();
	stopSpeechWsLoop();
	stopActionIdleTimer();
	stopSpeechHeartbeat();
	if (ttsSpeakStreamId) {
		void sendSpeechCancel(ttsSpeakStreamId, ttsSpeakLeaseId || null);
	}
	try {
		audioPlayer?.interrupt();
	} catch (err) {
		debugLog(`audio interrupt error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
	}
	try {
		audioPlayer?.close();
	} catch (err) {
		debugLog(`audio close error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
	}

	if (state.speechBusy) {
		try {
			speechAgent.abort();
		} catch (err) {
			debugLog(`speechAgent.abort error: ${err instanceof Error ? err.message : String(err)}`);
		}
		state.speechBusy = false;
	}
	if (state.actionBusy) {
		try {
			actionAgent.abort();
		} catch (err) {
			debugLog(`actionAgent.abort error: ${err instanceof Error ? err.message : String(err)}`);
		}
		state.actionBusy = false;
	}

	persistSpeechConversation();
	persistActionConversation();
}

process.on("SIGINT", () => {
	void shutdown("SIGINT").finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
	void shutdown("SIGTERM").finally(() => process.exit(0));
});

addActionLine(`Dual-agent ready with model "${modelName}" (${modelProvider}).`);
addActionLine(`World joined: ${worldBaseUrl} agent=${worldAgentName}`);
addActionLine(`Session key: ${worldSession}`);
addSpeechLine("Non-interactive mode enabled (plain logs, no TUI).");
if (disableSpeechAgent) {
	addSpeechLine("Speech agent disabled (--no-speech).");
}
if (disableAudio) {
	addSpeechLine("Audio generation/playback disabled (--no-audio).");
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

startSpeechWsLoop();
startStallCueLoop();

if (!disableActionAgent) void runActionPrompt("Fetch the skill commands and observe the world.");
if (!disableSpeechAgent) void runSpeechPrompt(agentConfig.initial_prompt || "You have just woken up in the world.", "startup_initial_prompt");
