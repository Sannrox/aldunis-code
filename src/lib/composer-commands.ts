import type {
  ProviderCapabilities,
  ProviderCommand,
  ProviderId,
  ProviderSkill,
} from "../types";

export type ComposerSuggestionMode = "path" | "slash-command" | "skill";

export interface ComposerTrigger {
  mode: ComposerSuggestionMode;
  query: string;
}

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: string;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "provider-slash-command";
      provider: ProviderId;
      command: ProviderCommand;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "skill";
      provider: ProviderId;
      skill: ProviderSkill;
      label: string;
      description: string;
    };

export interface ComposerCommandGroup {
  id: string;
  label: string;
  items: ComposerCommandItem[];
}

const BUILTIN_COMMANDS: ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>> = [
  {
    id: "slash:context",
    type: "slash-command",
    command: "context",
    label: "/context",
    description: "Inspect the Aldunis-owned draft context package",
  },
];

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "");
}

function normalizedQuery(query: string): string {
  return query.trim().toLocaleLowerCase().replace(/^[/\$]+/, "");
}

function itemSearchFields(item: ComposerCommandItem): string[] {
  switch (item.type) {
    case "path":
      return [item.label, item.path, item.description];
    case "slash-command":
      return [item.command, item.label, item.description];
    case "provider-slash-command":
      return [item.command.name, item.label, item.description];
    case "skill":
      return [item.skill.name, item.label, item.description];
  }
}

function itemSearchRank(item: ComposerCommandItem, query: string): number | null {
  const fields = itemSearchFields(item).map((field) => field.toLocaleLowerCase());
  const ranks = fields.flatMap((field, index) => {
    if (!field.includes(query)) return [];
    if (field === query) return [index * 10];
    if (field.startsWith(query)) return [index * 10 + 1];
    return [index * 10 + 2];
  });
  return ranks.length > 0 ? Math.min(...ranks) : null;
}

/** Return the active @, /, or $ token at the end of a composer draft. */
export function getComposerTrigger(draft: string): ComposerTrigger | null {
  const token = draft.match(/(?:^|\s)([@/$])([^\s]*)$/);
  if (!token) return null;
  const prefix = token[1];
  const query = token[2] ?? "";
  if (prefix === "/") return { mode: "slash-command", query };
  if (prefix === "$") return { mode: "skill", query };
  return { mode: "path", query };
}

/** Replace the active trigger token while preserving its leading whitespace. */
export function replaceComposerTrigger(draft: string, replacement: string): string {
  const token = draft.match(/(?:^|\s)([@/$])([^\s]*)$/);
  if (!token || token.index === undefined) return draft;
  const tokenText = (token[1] ?? "") + (token[2] ?? "");
  const tokenOffset = token[0].lastIndexOf(tokenText);
  const start = token.index + tokenOffset;
  return draft.slice(0, start) + replacement + draft.slice(start + tokenText.length);
}

/** Apply stable, lightweight ranking while preserving provider declaration order for ties. */
export function filterComposerCommandItems(
  items: ReadonlyArray<ComposerCommandItem>,
  query: string,
): ComposerCommandItem[] {
  const normalized = normalizedQuery(query);
  if (!normalized) return [...items];

  return items
    .flatMap((item, index) => {
      const rank = itemSearchRank(item, normalized);
      return rank === null ? [] : [{ item, rank, index }];
    })
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ item }) => item);
}

export function buildComposerCommandItems(input: {
  provider: ProviderId;
  capabilities: ProviderCapabilities | null;
  query: string;
}): ComposerCommandItem[] {
  // The host capability projection is currently Claude-specific. Keep its
  // commands scoped to that provider instead of leaking them into adapters
  // that do not yet expose normalized command metadata.
  const providerCommands = input.capabilities?.provider === input.provider
    ? (input.capabilities.commands ?? []).map((command) => {
      const name = normalizeCommandName(command.name);
      return {
        id: "provider-slash-command:" + input.provider + ":" + name,
        type: "provider-slash-command" as const,
        provider: input.provider,
        command,
        label: "/" + name,
        description: command.description,
      };
    })
    : [];

  return filterComposerCommandItems(
    [...BUILTIN_COMMANDS, ...providerCommands],
    input.query,
  );
}

export function buildComposerSkillItems(
  provider: ProviderId,
  skills: ReadonlyArray<ProviderSkill>,
  query: string,
): ComposerCommandItem[] {
  return filterComposerCommandItems(
    skills.map((skill) => ({
      id: "skill:" + provider + ":" + skill.name,
      type: "skill" as const,
      provider,
      skill,
      label: "$" + skill.name,
      description: skill.description,
    })),
    query,
  );
}

export function buildComposerPathItems(paths: ReadonlyArray<string>): ComposerCommandItem[] {
  return paths.map((path) => ({
    id: "path:" + path,
    type: "path" as const,
    path,
    label: path,
    description: "Local repository file",
  }));
}

export function groupComposerCommandItems(
  items: ReadonlyArray<ComposerCommandItem>,
  mode: ComposerSuggestionMode,
): ComposerCommandGroup[] {
  if (mode === "path") {
    return items.length > 0 ? [{ id: "files", label: "Files", items: [...items] }] : [];
  }
  if (mode === "skill") {
    return items.length > 0 ? [{ id: "skills", label: "Skills", items: [...items] }] : [];
  }

  const groups: ComposerCommandGroup[] = [];
  const builtIn = items.filter((item) => item.type === "slash-command");
  const provider = items.filter((item) => item.type === "provider-slash-command");
  if (builtIn.length > 0) groups.push({ id: "built-in", label: "Built-in", items: builtIn });
  if (provider.length > 0) groups.push({ id: "provider", label: "Provider", items: provider });
  return groups;
}
