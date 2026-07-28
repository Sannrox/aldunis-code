import type { ProviderEvent, ProviderPlanArtifact } from "../types";
import { joinAssistantTextChunks } from "./assistant-text";
import { mergePlanArtifact } from "./provider-plan";
import { presentToolRows, type ToolRow } from "./tool-presentation";

export type AssistantTimelineBlock =
  | { kind: "text"; text: string }
  | { kind: "plan"; artifact: ProviderPlanArtifact }
  | { kind: "tools"; rows: ToolRow[] };

/**
 * Preserve the provider event stream as a readable assistant timeline.
 *
 * Tool finishes update the tool group containing their matching start event;
 * they do not move that group below later assistant text.
 */
export function presentAssistantTimeline(
  events: ProviderEvent[],
  unfinishedStatus: "running" | "cancelled" = "running",
): AssistantTimelineBlock[] {
  const blocks: Array<
    | { kind: "text"; chunks: string[] }
    | { kind: "plan"; artifact: ProviderPlanArtifact }
    | {
        kind: "tools";
        events: Array<Extract<ProviderEvent, { kind: "tool_started" | "tool_finished" }>>;
        toolCallIds: Set<string>;
      }
  > = [];
  const toolBlockByCallId = new Map<string, Extract<(typeof blocks)[number], { kind: "tools" }>>();
  const planBlockById = new Map<string, Extract<(typeof blocks)[number], { kind: "plan" }>>();

  for (const event of events) {
    if (event.kind === "assistant_text") {
      const last = blocks.at(-1);
      if (last?.kind === "text") last.chunks.push(event.text);
      else blocks.push({ kind: "text", chunks: [event.text] });
      continue;
    }
    if (event.kind === "plan_updated") {
      const id = `${event.artifact.provider}\n${event.artifact.id}`;
      const existing = planBlockById.get(id);
      if (existing) {
        existing.artifact = mergePlanArtifact(existing.artifact, event);
      } else {
        const block = { kind: "plan" as const, artifact: mergePlanArtifact(undefined, event) };
        blocks.push(block);
        planBlockById.set(id, block);
      }
      continue;
    }
    if (event.kind !== "tool_started" && event.kind !== "tool_finished") continue;

    const existing = toolBlockByCallId.get(event.toolCallId);
    if (existing) {
      existing.events.push(event);
      continue;
    }
    const last = blocks.at(-1);
    const block = last?.kind === "tools"
      ? last
      : { kind: "tools" as const, events: [], toolCallIds: new Set<string>() };
    if (last !== block) blocks.push(block);
    block.events.push(event);
    block.toolCallIds.add(event.toolCallId);
    toolBlockByCallId.set(event.toolCallId, block);
  }

  return blocks.flatMap((block): AssistantTimelineBlock[] => {
    if (block.kind === "text") {
      const text = joinAssistantTextChunks(block.chunks);
      return text ? [{ kind: "text", text }] : [];
    }
    if (block.kind === "plan") return [block];
    return [{
      kind: "tools",
      rows: presentToolRows(block.events).map((row) => (
        row.status === "running" && unfinishedStatus === "cancelled"
          ? { ...row, status: "cancelled" }
          : row
      )),
    }];
  });
}
