export type ActionPayload = { type: string; data: Record<string, unknown> };
export type ActionParseError = { reason: string; raw: string };

export function parseActionPayloads(text: string): { actions: ActionPayload[]; errors: ActionParseError[] } {
  const out: ActionPayload[] = [];
  const errors: ActionParseError[] = [];
  const re = /<action>([\s\S]*?)<\/action>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = String(m[1] || "").trim();
    if (!raw) {
      errors.push({ reason: "empty_payload", raw: "" });
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as { type?: unknown; data?: unknown };
      const type = typeof parsed?.type === "string" ? parsed.type.trim() : "";
      if (!type) {
        errors.push({ reason: "missing_type", raw });
        continue;
      }
      const data = parsed?.data && typeof parsed.data === "object"
        ? (parsed.data as Record<string, unknown>)
        : {};
      out.push({ type, data });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      errors.push({ reason: `invalid_json:${reason}`, raw });
    }
  }
  return { actions: out, errors };
}

export function extractActionPayloads(text: string): ActionPayload[] {
  return parseActionPayloads(text).actions;
}
