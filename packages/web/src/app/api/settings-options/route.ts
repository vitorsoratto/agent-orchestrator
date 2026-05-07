import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

const FALLBACK_AGENTS = ["claude-code", "codex", "pi", "opencode", "aider", "cursor", "kimicode"];
const FALLBACK_RUNTIMES = ["tmux", "process"];
const FALLBACK_TRACKERS = ["github", "linear", "gitlab"];
const FALLBACK_SCMS = ["github", "gitlab"];
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const PERMISSIONS = ["permissionless", "default", "auto-edit", "suggest"];

const DEFAULT_MODELS_BY_AGENT: Record<string, string[]> = {
  "claude-code": ["opus", "sonnet", "haiku"],
  codex: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.3-codex-spark"],
  pi: ["openai-codex/gpt-5.5"],
  opencode: ["gpt-5.5", "claude-sonnet-4.5", "kimi-k2.6"],
};

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function pluginNames(slotValues: Array<{ name: string }>, fallback: string[]): string[] {
  return unique([...fallback, ...slotValues.map((plugin) => plugin.name)]);
}

async function listPiModels(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("pi", ["--list-models", "gpt-5.5"], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    const lines = stdout.split("\n").slice(1);
    return lines
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 2)
      .map(([provider, model]) => `${provider}/${model}`);
  } catch {
    return [];
  }
}

export async function GET() {
  const { registry } = await getServices();
  const piModels = await listPiModels();

  return NextResponse.json({
    agents: pluginNames(registry.list("agent"), FALLBACK_AGENTS),
    runtimes: pluginNames(registry.list("runtime"), FALLBACK_RUNTIMES),
    trackers: pluginNames(registry.list("tracker"), FALLBACK_TRACKERS),
    scms: pluginNames(registry.list("scm"), FALLBACK_SCMS),
    reasoningEfforts: REASONING_EFFORTS,
    permissions: PERMISSIONS,
    modelsByAgent: {
      ...DEFAULT_MODELS_BY_AGENT,
      pi: unique([...DEFAULT_MODELS_BY_AGENT.pi, ...piModels]),
    },
    orchestrationModes: ["delegate_only", "coordinate", "off"],
  });
}
