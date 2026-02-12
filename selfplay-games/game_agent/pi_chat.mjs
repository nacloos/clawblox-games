import { Agent } from "/home/nacloos/Code/pi-mono/packages/agent/dist/index.js";
import { getModel } from "/home/nacloos/Code/pi-mono/packages/ai/dist/index.js";
import { createBashTool } from "/home/nacloos/Code/pi-mono/packages/coding-agent/dist/index.js";
import { createInterface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { existsSync, readFileSync } from "node:fs";
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

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
	console.error("Missing ANTHROPIC_API_KEY (set env var or add it to .env)");
	process.exit(1);
}

const modelName = process.env.PI_MODEL || "claude-opus-4-6";
const systemPrompt =
	process.env.PI_SYSTEM_PROMPT || "You are a concise helpful assistant.";

const agent = new Agent({
	initialState: {
		systemPrompt,
		model: getModel("anthropic", modelName),
		thinkingLevel: "off",
		tools: [createBashTool(process.cwd())],
	},
	getApiKey: (provider) => (provider === "anthropic" ? apiKey : undefined),
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
	`Chat ready with model "${modelName}". Commands: /reset, /quit`
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
