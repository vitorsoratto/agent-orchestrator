/**
 * Orchestrator Prompt Generator - generates orchestrator prompt content.
 *
 * This is injected via `ao start` to provide orchestrator-specific context
 * when the orchestrator agent runs.
 */

import orchestratorTemplate from "./prompts/orchestrator.md";
import type { OrchestratorConfig, ProjectConfig } from "./types.js";

export interface OrchestratorPromptConfig {
  config: OrchestratorConfig;
  projectId: string;
  project: ProjectConfig;
}

interface OrchestratorPromptRenderData {
  projectId: string;
  projectName: string;
  projectRepo: string;
  projectDefaultBranch: string;
  projectSessionPrefix: string;
  projectPath: string;
  dashboardPort: string;
  automatedReactionsSection: string;
  projectSpecificRulesSection: string;
  repoConfiguredSection: string;
  repoNotConfiguredSection: string;
  collectionSection: string;
  orchestrationPolicySection: string;
}

type OrchestratorPromptRenderKey = keyof OrchestratorPromptRenderData;

function buildAutomatedReactionsSection(project: ProjectConfig): string {
  const markdownBold = String.fromCharCode(42).repeat(2);
  const bold = (text: string): string => `${markdownBold}${text}${markdownBold}`;

  const reactionLines: string[] = [];

  for (const [event, reaction] of Object.entries(project.reactions ?? {})) {
    if (reaction.auto && reaction.action === "send-to-agent") {
      reactionLines.push(
        `- ${bold(event)}: Auto-sends instruction to agent (retries: ${reaction.retries ?? "none"}, escalates after: ${reaction.escalateAfter ?? "never"})`,
      );
      continue;
    }

    if (reaction.auto && reaction.action === "notify") {
      reactionLines.push(
        `- ${bold(event)}: Notifies human (priority: ${reaction.priority ?? "info"})`,
      );
    }
  }

  if (reactionLines.length === 0) {
    return "";
  }

  return reactionLines.join("\n");
}

function buildProjectSpecificRulesSection(project: ProjectConfig): string {
  const rules = project.orchestratorRules?.trim();
  if (!rules) {
    return "";
  }

  return rules;
}

function buildCollectionSection(project: ProjectConfig): string {
  if (project.projectKind !== "collection") return "";
  const contextDir = project.contextDir ?? ".ao/context";
  const repos = project.repos ?? {};
  const profiles = project.profiles ?? { default: Object.keys(repos) };
  const lines = [
    "## Collection Project",
    "",
    `- Collection root: ${project.path}`,
    `- Shared context directory: ${contextDir}`,
    `- Default profile: ${(profiles.default ?? []).join(", ") || "empty"}`,
    "",
    "Subprojects:",
  ];

  for (const [repoKey, repo] of Object.entries(repos)) {
    lines.push(`- ${repoKey}: ${repo.path} (${repo.repo ?? "no remote"}, default ${repo.defaultBranch})`);
  }

  if (Object.keys(repos).length === 0) {
    lines.push("- No subprojects are registered yet. Use the project settings UI to add them.");
  }

  lines.push("");
  lines.push("When spawning workers for this collection, prefer prompt-driven tasks. Workers receive a composite workspace with the selected subproject worktrees and the shared context directory.");
  return lines.join("\n");
}

function formatAgentConfigValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function buildOrchestrationPolicySection(project: ProjectConfig): string {
  const policy = project.orchestration;
  if (!policy) return "";

  const mode = policy.mode ?? "coordinate";
  const subagents = policy.subagents ?? {};
  const lines = [
    "## Orchestration Policy",
    "",
    `- Mode: ${mode}`,
    `- Default worker profile: ${policy.defaultSubagent ?? "none"}`,
  ];

  if (mode === "delegate_only") {
    lines.push(
      "- You are delegate-only: keep repository implementation read-only in the orchestrator session.",
      "- Spawn AO worker sessions for implementation, repo mutation, branch work, test runs tied to changes, and PR ownership.",
      "- Do not use Claude Code/oh-my-claudecode native subagents, Task agents, OMC agents, or harness-local subagent mechanisms for project work; they are outside AO tracking and cannot honor AO worker profiles.",
      "- Your job is to analyze, decompose, dispatch, monitor, review worker output, and consolidate the final answer.",
    );
  }

  lines.push("", "Worker profiles:");
  if (Object.keys(subagents).length === 0) {
    lines.push("- No worker profiles configured.");
  }

  for (const [name, profile] of Object.entries(subagents)) {
    const details = Object.entries(profile.agentConfig ?? {})
      .map(([key, value]) => `${key}=${formatAgentConfigValue(value)}`)
      .filter(Boolean)
      .join(", ");
    const repos = profile.repos?.length ? ` repos=${profile.repos.join(",")}` : "";
    const description = profile.description ? ` - ${profile.description}` : "";
    lines.push(
      `- ${name}: agent=${profile.agent}${details ? ` (${details})` : ""}${repos}${description}`,
    );
  }

  if (Object.keys(subagents).length > 0) {
    lines.push(
      "",
      "Spawn AO workers with the selected profile:",
      "```bash",
      'ao spawn --worker-profile <profile> --prompt "..."',
      "```",
      "Use different worker profiles when model/harness diversity is useful. State which profile owns each delegated task.",
    );
  }

  return lines.join("\n");
}

function removeOptionalSectionBlocks(
  template: string,
  data: OrchestratorPromptRenderData,
): string {
  const templates = [
    ["REPO_CONFIGURED_SECTION_START", "REPO_CONFIGURED_SECTION_END", data.repoConfiguredSection],
    ["REPO_NOT_CONFIGURED_SECTION_START", "REPO_NOT_CONFIGURED_SECTION_END", data.repoNotConfiguredSection],
    ["AUTOMATED_REACTIONS_SECTION_START", "AUTOMATED_REACTIONS_SECTION_END", data.automatedReactionsSection],
    ["PROJECT_SPECIFIC_RULES_SECTION_START", "PROJECT_SPECIFIC_RULES_SECTION_END", data.projectSpecificRulesSection],
    ["COLLECTION_SECTION_START", "COLLECTION_SECTION_END", data.collectionSection],
    ["ORCHESTRATION_POLICY_SECTION_START", "ORCHESTRATION_POLICY_SECTION_END", data.orchestrationPolicySection],
  ] as const;

  let interpolated = template;
  for (const [startKey, endKey, section] of templates) {
    const startMarker = `{{${startKey}}}`;
    const endMarker = `{{${endKey}}}`;

    while (true) {
      const start = interpolated.indexOf(startMarker);
      const end = interpolated.indexOf(endMarker);

      if (start === -1 && end === -1) {
        break;
      }

      if (start === -1 || end === -1 || end < start) {
        throw new Error(
          `Malformed optional section block: expected ${startMarker} before ${endMarker}`,
        );
      }

      const fullStart = start;
      const fullEnd = end + endMarker.length;
      const blockContent = interpolated.slice(start + startMarker.length, end);
      // Optional sections are flat by design. Reject nesting of the same block
      // type so future template edits fail loudly instead of matching ambiguously.
      if (blockContent.includes(startMarker)) {
        throw new Error(
          `Nested optional section blocks are not supported: ${startMarker} before ${endMarker}`,
        );
      }

      const replacement = section ? blockContent : "";
      const before = interpolated.slice(0, fullStart);
      const after = interpolated.slice(fullEnd);

      interpolated = replacement
        ? before + replacement + after
        : collapseOptionalGap(before, after);
    }
  }

  return interpolated;
}

function collapseOptionalGap(before: string, after: string): string {
  const trailingNewlines = before.match(/\n*$/)?.[0] ?? "";
  const leadingNewlines = after.match(/^\n*/)?.[0] ?? "";
  const totalNewlines = trailingNewlines.length + leadingNewlines.length;
  const boundary = totalNewlines >= 2 ? "\n\n" : trailingNewlines + leadingNewlines;

  return (
    before.slice(0, before.length - trailingNewlines.length) +
    boundary +
    after.slice(leadingNewlines.length)
  );
}

function hasRenderDataKey(
  data: OrchestratorPromptRenderData,
  key: string,
): key is OrchestratorPromptRenderKey {
  return Object.prototype.hasOwnProperty.call(data, key);
}

function createRenderData(opts: OrchestratorPromptConfig): OrchestratorPromptRenderData {
  const { config, projectId, project } = opts;
  const hasRepo = Boolean(project.repo);

  return {
    projectId,
    projectName: project.name,
    projectRepo: project.repo ?? "not configured",
    projectDefaultBranch: project.defaultBranch,
    projectSessionPrefix: project.sessionPrefix,
    projectPath: project.path,
    dashboardPort: String(config.port ?? 3000),
    automatedReactionsSection: buildAutomatedReactionsSection(project),
    projectSpecificRulesSection: buildProjectSpecificRulesSection(project),
    collectionSection: buildCollectionSection(project),
    orchestrationPolicySection: buildOrchestrationPolicySection(project),
    repoConfiguredSection: hasRepo ? "true" : "",
    repoNotConfiguredSection: hasRepo ? "" : "true",
  };
}

function renderTemplate(template: string, data: OrchestratorPromptRenderData): string {
  const unresolvedPlaceholder = template
    .replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, "")
    .match(/\{\{[^}]+\}\}/);
  if (unresolvedPlaceholder) {
    throw new Error(`Unresolved template placeholder: ${unresolvedPlaceholder[0]}`);
  }

  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, rawKey: string) => {
    if (!hasRenderDataKey(data, rawKey)) {
      throw new Error(`Unresolved template placeholder: ${rawKey}`);
    }

    return data[rawKey];
  });
}

function finalizeRenderedPrompt(prompt: string): string {
  return prompt.trim();
}

/**
 * Generate orchestrator prompt content.
 * Provides orchestrator agent with context about available commands,
 * session management workflows, and project configuration.
 */
export function generateOrchestratorPrompt(opts: OrchestratorPromptConfig): string {
  const data = createRenderData(opts);
  const templateWithOptionalSections = removeOptionalSectionBlocks(
    orchestratorTemplate.trim(),
    data,
  );

  return finalizeRenderedPrompt(
    renderTemplate(templateWithOptionalSections, data),
  );
}
