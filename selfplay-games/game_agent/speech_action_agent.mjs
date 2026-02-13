import { Agent } from "/home/nacloos/Code/pi-mono/packages/agent/dist/index.js";
import { getModel } from "/home/nacloos/Code/pi-mono/packages/ai/dist/index.js";
import { createBashTool } from "/home/nacloos/Code/pi-mono/packages/coding-agent/dist/index.js";
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

loadDotEnvFromCwdAndParents();

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
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

function loadCodexAccessToken() {
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

const codexAccessToken = loadCodexAccessToken();
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
const modelProvider = process.env.PI_PROVIDER || (codexAccessToken ? "openai-codex" : "anthropic");
const modelName = process.env.PI_MODEL || (modelProvider === "openai-codex" ? "gpt-5.3-codex" : "claude-opus-4-6");

if (modelProvider === "openai-codex" && !codexAccessToken) {
	console.error("Missing Codex OAuth token. Run: npx @mariozechner/pi-ai login openai-codex");
	process.exit(1);
}
if (modelProvider === "anthropic" && !anthropicApiKey) {
	console.error("Missing ANTHROPIC_API_KEY (set env var or add it to .env)");
	process.exit(1);
}

function loadContextFile(name) {
	return readFileSync(path.join(agentDir, name), "utf8").trim();
}

function buildSystemPrompt() {
	const base = process.env.PI_SYSTEM_PROMPT || "";
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
		if (content) {
			lines.push("---", "", `**${file}** (${filePath})`, "", content, "");
		}
	}

	lines.push(
		"## Workspace",
		"",
		`Your workspace is ${agentDir}. Only work inside this directory.`,
		"",
		"Use bash to observe and act quickly, keep state continuity, and prioritize practical progress.",
		"Keep commands short and non-blocking.",
	);

	return lines.join("\n");
}

const systemPrompt = buildSystemPrompt();

const agent = new Agent({
	initialState: {
		systemPrompt,
		model: getModel(modelProvider, modelName),
		thinkingLevel: "off",
		tools: [createBashTool(process.cwd())],
	},
	getApiKey: (provider) => {
		if (provider === "openai-codex") return codexAccessToken;
		if (provider === "anthropic") return anthropicApiKey;
		return undefined;
	},
});

let isBusy = false;
let isClosing = false;
let assistantSawDelta = false;

function printPrompt(rl) {
	if (!isClosing && !isBusy) {
		rl.prompt();
	}
}

agent.subscribe((event) => {
	if (event.type === "message_start" && event.message.role === "assistant") {
		assistantSawDelta = false;
		output.write("assistant> ");
		return;
	}
	if (
		event.type === "message_update" &&
		event.assistantMessageEvent.type === "text_delta"
	) {
		assistantSawDelta = true;
		output.write(event.assistantMessageEvent.delta);
		return;
	}
	if (
		event.type === "message_update" &&
		event.assistantMessageEvent.type === "toolcall_end"
	) {
		const tc = event.assistantMessageEvent.toolCall;
		output.write(`\n[tool_call] ${tc.name}(${JSON.stringify(tc.arguments)})\n`);
		return;
	}
	writeFileSync("conversation.json", JSON.stringify(agent.state.messages, null, 2));
	if (event.type === "message_end" && event.message.role === "assistant") {
		if (!assistantSawDelta) {
			const text = event.message.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");
			output.write(text);
		}
		output.write("\n");
		assistantSawDelta = false;
	}
});

const rl = createInterface({ input, output, terminal: true });
rl.setPrompt("you> ");
console.log(
	`Chat ready with model "${modelName}" (${modelProvider}). Commands: /reset, /quit`
);
printPrompt(rl);

rl.on("line", (rawLine) => {
	const line = rawLine.trim();
	if (!line) {
		printPrompt(rl);
		return;
	}
	if (isBusy) {
		output.write("assistant> Still processing previous request.\n");
		printPrompt(rl);
		return;
	}
	if (line === "/quit" || line === "/exit") {
		isClosing = true;
		rl.close();
		return;
	}
	if (line === "/reset") {
		agent.reset();
		agent.setSystemPrompt(buildSystemPrompt());
		output.write("assistant> Context cleared.\n");
		printPrompt(rl);
		return;
	}

	isBusy = true;
	(async () => {
		try {
			await agent.prompt(line);
		} catch (error) {
			console.error(
				"Chat error:",
				error instanceof Error ? error.message : error
			);
		} finally {
			isBusy = false;
			printPrompt(rl);
		}
	})();
});

rl.on("SIGINT", () => {
	if (isBusy) {
		agent.abort();
		output.write("\nassistant> Aborted.\n");
		isBusy = false;
		printPrompt(rl);
		return;
	}
	isClosing = true;
	rl.close();
});

rl.on("close", () => {
	process.exit(0);
});
