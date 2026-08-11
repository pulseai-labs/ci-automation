/**
 * The server (opencode 1.17.8) accepts `format` on POST /session/{sessionID}/message
 * — verified against its own OpenAPI document, where the property is
 * `anyOf: [OutputFormatText, OutputFormatJsonSchema]`.
 *
 * @opencode-ai/sdk@1.17.8's generated `SessionPromptData["body"]` type omits both
 * `format` and `variant`. The capability exists; the typed client cannot name it.
 * This shim adds the field and casts once, in one place, with this comment attached.
 *
 * Empirically corroborated for Task 12: a real `session.prompt` with
 * `format: { type: "json_schema", schema, retryCount }` reaches the server and
 * opencode injects its "IMPORTANT: ... You MUST use the StructuredOutput tool"
 * system instruction in response (confirmed in the opencode binary). The SDK's
 * generated `SessionPromptData["body"]` also omits `tools`; the same cast covers
 * re-enabling tools per turn (amendment A12-2).
 *
 * Revisit when the SDK types catch up — then delete this file and inline the call.
 */
export interface OutputFormatJsonSchema {
  type: "json_schema";
  schema: Record<string, unknown>;
  retryCount?: number;
}

export async function promptWithFormat(
  client: any,
  sessionID: string,
  body: Record<string, unknown> & { format?: OutputFormatJsonSchema },
) {
  return client.session.prompt({ path: { id: sessionID }, body: body as any });
}
