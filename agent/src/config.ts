import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentConfig } from "./types.js";

export type RuntimeConfig = {
  agentName: string;
  gameDir: string;
  logsDir: string;
  resultsDir: string;
  workspaceDir: string;
  debugLogPath: string;
  worldBaseUrl: string;
  modelProvider: string;
  modelName: string;
  noAudio: boolean;
  noSpeech: boolean;
  noAction: boolean;
  speechConversationPath: string;
  actionConversationPath: string;
  speechSystemPromptPath: string;
  actionSystemPromptPath: string;
  speechSystemPrompt: string;
  actionSystemPrompt: string;
  agentConfig: AgentConfig;
};

function loadDotEnvIntoProcessEnv(envPath: string) {
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function loadDotEnvFromCwdAndParents(maxLevels = 4) {
  let dir = process.cwd();
  for (let i = 0; i < maxLevels; i += 1) {
    loadDotEnvIntoProcessEnv(path.join(dir, ".env"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function listMdFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md"));
}

function loadContextFile(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, "utf8").trim() : "";
}

function buildWorkspaceContext(gameDir: string, agentName: string): string {
  const agentDir = path.join(gameDir, "workspace", agentName);
  const agentTemplateDir = path.join(gameDir, "templates", "agents", agentName);
  const defaultTemplateDir = path.join(gameDir, "templates", "agent");
  const worldTemplateDir = path.join(gameDir, "templates", "world");
  const sharedFiles = new Set(["SOUL.md"]);

  mkdirSync(agentDir, { recursive: true });

  const allFiles = [...new Set([...listMdFiles(defaultTemplateDir), ...listMdFiles(agentTemplateDir)])];
  const contextFiles = allFiles.filter((f) => !sharedFiles.has(f));

  for (const file of contextFiles) {
    const dest = path.join(agentDir, file);
    if (existsSync(dest)) continue;
    const agentSrc = path.join(agentTemplateDir, file);
    const defaultSrc = path.join(defaultTemplateDir, file);
    const src = existsSync(agentSrc) ? agentSrc : defaultSrc;
    if (existsSync(src)) writeFileSync(dest, readFileSync(src, "utf8"));
  }

  const lines: string[] = [
    "## Workspace",
    "",
    `Your workspace is ${agentDir}. Only work inside this directory.`,
    "",
    "# Project Context",
    "",
    "SOUL.md is shared globally across all agents from templates/agent/SOUL.md.",
    "All other memory files below are agent-local workspace files.",
    ""
  ];

  const sharedSoulPath = path.join(defaultTemplateDir, "SOUL.md");
  const sharedSoul = loadContextFile(sharedSoulPath);
  if (sharedSoul) {
    lines.push("---", "", `**SOUL.md** (${sharedSoulPath})`, "", sharedSoul, "");
  }

  for (const file of contextFiles) {
    const filePath = path.join(agentDir, file);
    const content = loadContextFile(filePath);
    if (content) lines.push("---", "", `**${file}** (${filePath})`, "", content, "");
  }

  const worldMdFiles = listMdFiles(worldTemplateDir);
  if (worldMdFiles.length > 0) {
    lines.push("---", "", "# World Reference (read-only)", "");
    for (const file of worldMdFiles) {
      const content = loadContextFile(path.join(worldTemplateDir, file));
      if (content) lines.push(`**${file}**`, "", content, "");
    }
  }

  return lines.join("\n");
}

export function loadRuntimeConfig(argv: string[]): RuntimeConfig {
  loadDotEnvFromCwdAndParents();

  const cliFlags = new Set(argv.filter((a) => a.startsWith("--") && !a.includes("=")));
  const cliNameArg = argv.find((a) => a.startsWith("--name="))?.split("=")[1] || argv[argv.indexOf("--name") + 1];
  const cliDir = argv.find((a) => a.startsWith("--dir="))?.split("=")[1] || argv[argv.indexOf("--dir") + 1];

  const scriptPath = new URL(import.meta.url).pathname;
  const scriptDir = path.dirname(path.dirname(scriptPath));
  const gameDir = cliDir ? path.resolve(cliDir) : scriptDir;
  const agentName = cliNameArg || process.env.WORLD_AGENT_NAME || "agent";

  const logsDir = path.join(gameDir, "logs");
  const resultsDir = path.join(gameDir, "results", agentName);
  const workspaceDir = path.join(gameDir, "workspace", agentName);

  mkdirSync(logsDir, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  const debugLogPath = process.env.DEBUG_LOG_PATH || path.join(logsDir, `${agentName}.debug.log`);

  const speechConversationPath = path.join(resultsDir, "speech_conversation.json");
  const actionConversationPath = path.join(resultsDir, "action_conversation.json");
  const speechSystemPromptPath = path.join(resultsDir, "system-prompt-speech.md");
  const actionSystemPromptPath = path.join(resultsDir, "system-prompt-action.md");

  const worldBaseUrl = process.env.WORLD_BASE_URL || "http://localhost:8080";
  const modelProvider = process.env.PI_PROVIDER || "anthropic";
  const modelName = process.env.PI_MODEL || (modelProvider === "openai-codex" ? "gpt-5.3-codex" : "claude-opus-4-6");

  const agentTemplateDir = path.join(gameDir, "templates", "agents", agentName);
  const agentConfigPath = path.join(agentTemplateDir, "config.json");
  const agentConfig: AgentConfig = existsSync(agentConfigPath)
    ? JSON.parse(readFileSync(agentConfigPath, "utf8")) as AgentConfig
    : {};

  const workspaceContext = buildWorkspaceContext(gameDir, agentName);

  const speechSystemPrompt = [
    "You are a being living in your world.",
    "Always use the tags <speak>...</speak> to speak out loud. No one will hear what you say outside of these tags.",
    "Use <silence></silence> to say nothing. Only speak when addressed or you have something important to add.",
    "Keep it concise (one sentence preferred).",
    "To take a world action, output JSON payload inside <action>...</action> with {\"type\":\"...\",\"data\":{...}}.",
    "After you cast a vote, briefly announce once that your vote is in so the host can proceed.",
    workspaceContext
  ].join("\n\n");

  const actionSystemPrompt = [
    "You are a world actor.",
    "Return concise world action/observation steps.",
    workspaceContext
  ].join("\n\n");

  writeFileSync(speechSystemPromptPath, speechSystemPrompt);
  writeFileSync(actionSystemPromptPath, actionSystemPrompt);

  return {
    agentName,
    gameDir,
    logsDir,
    resultsDir,
    workspaceDir,
    debugLogPath,
    worldBaseUrl,
    modelProvider,
    modelName,
    noAudio: cliFlags.has("--no-audio"),
    noSpeech: cliFlags.has("--no-speech"),
    noAction: cliFlags.has("--no-action"),
    speechConversationPath,
    actionConversationPath,
    speechSystemPromptPath,
    actionSystemPromptPath,
    speechSystemPrompt,
    actionSystemPrompt,
    agentConfig,
  };
}
