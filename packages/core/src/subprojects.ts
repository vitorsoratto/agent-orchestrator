import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  loadLocalProjectConfigDetailed,
  writeLocalProjectConfig,
  type LocalProjectConfig,
} from "./global-config.js";
import { detectScmPlatform } from "./config-generator.js";
import type { ProjectConfig, RepoTargetConfig, SCMConfig, TrackerConfig } from "./types.js";

type LocalRepoConfig = NonNullable<LocalProjectConfig["repos"]>[string];

export interface SubprojectCandidate {
  repoKey: string;
  name: string;
  path: string;
  absolutePath: string;
  repo?: string;
  defaultBranch: string;
  scm?: SCMConfig;
  tracker?: TrackerConfig;
  added: boolean;
}

export interface SubprojectsList {
  projectKind: "repo" | "collection";
  contextDir: string;
  subprojects: SubprojectCandidate[];
}

const DEFAULT_CONTEXT_DIR = ".ao/context";
const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".ao",
  ".omc",
  "node_modules",
  "dist",
  "build",
  ".next",
]);

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
}

function assertCollectionProject(projectId: string, project: ProjectConfig): void {
  if (project.projectKind !== "collection") {
    throw new Error(`Project "${projectId}" is not a collection project.`);
  }
}

function assertRelativeChildPath(rawPath: string): void {
  if (!rawPath || rawPath.startsWith("/") || rawPath.split(/[\\/]/).includes("..")) {
    throw new Error(`Invalid subproject path "${rawPath}".`);
  }
}

function sanitizeRepoKey(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return sanitized || "repo";
}

function uniqueRepoKey(base: string, existing: Record<string, unknown>): string {
  if (!existing[base]) return base;
  for (let i = 2; i < 10_000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existing[candidate]) return candidate;
  }
  throw new Error(`Could not allocate repo key for "${base}".`);
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

function isGitRepo(path: string): boolean {
  return git(path, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

function detectDefaultBranch(path: string): string {
  const originHead = git(path, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead?.startsWith("origin/")) return originHead.slice("origin/".length);

  const current = git(path, ["branch", "--show-current"]);
  return current || "main";
}

function normalizeOriginUrl(originUrl: string): string {
  const sshMatch = originUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2]}`;
  return originUrl.replace(/\.git$/, "").replace(/\/$/, "");
}

function repoFromOrigin(originUrl: string | null): string | undefined {
  if (!originUrl) return undefined;
  const normalized = normalizeOriginUrl(originUrl);
  try {
    const parsed = new URL(normalized);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return undefined;
    return `${parts.slice(0, -1).join("/")}/${parts[parts.length - 1]}`;
  } catch {
    return undefined;
  }
}

function pluginFromOrigin(originUrl: string | null): { plugin: string } | undefined {
  if (!originUrl) return undefined;
  const normalized = normalizeOriginUrl(originUrl);
  try {
    const platform = detectScmPlatform(new URL(normalized).host);
    if (platform === "github" || platform === "gitlab") return { plugin: platform };
  } catch {
    return undefined;
  }
  return undefined;
}

function configWithPlugin<T extends { plugin?: string }>(
  config: T | undefined,
): ({ plugin: string } & Omit<T, "plugin">) | undefined {
  return config?.plugin ? ({ ...config, plugin: config.plugin } as { plugin: string } & Omit<T, "plugin">) : undefined;
}

function localReposFromProject(project: ProjectConfig): NonNullable<LocalProjectConfig["repos"]> {
  return Object.fromEntries(
    Object.entries(project.repos ?? {}).map(([repoKey, repo]) => [
      repoKey,
      {
        path: repo.path,
        defaultBranch: repo.defaultBranch,
        ...(repo.name ? { name: repo.name } : {}),
        ...(repo.repo ? { repo: repo.repo } : {}),
        ...(configWithPlugin(repo.scm) ? { scm: configWithPlugin(repo.scm) } : {}),
        ...(configWithPlugin(repo.tracker) ? { tracker: configWithPlugin(repo.tracker) } : {}),
      },
    ]),
  );
}

function detectCandidate(rootPath: string, absolutePath: string, added: boolean, repoKey?: string): SubprojectCandidate {
  const relPath = relative(rootPath, absolutePath);
  const name = basename(absolutePath);
  const originUrl = git(absolutePath, ["remote", "get-url", "origin"]);
  const plugin = pluginFromOrigin(originUrl);
  const repo = repoFromOrigin(originUrl);
  return {
    repoKey: repoKey ?? sanitizeRepoKey(name),
    name,
    path: relPath,
    absolutePath,
    ...(repo ? { repo } : {}),
    defaultBranch: detectDefaultBranch(absolutePath),
    ...(plugin ? { scm: plugin, tracker: plugin } : {}),
    added,
  };
}

function scanGitRepos(rootPath: string): SubprojectCandidate[] {
  const root = resolve(rootPath);
  if (!existsSync(root)) return [];

  const results: SubprojectCandidate[] = [];
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
      const absolutePath = join(current, entry.name);
      if (isGitRepo(absolutePath)) {
        results.push(detectCandidate(root, absolutePath, false));
        continue;
      }
      queue.push(absolutePath);
    }
  }

  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function loadEditableLocalConfig(project: ProjectConfig): LocalProjectConfig {
  const loaded = loadLocalProjectConfigDetailed(project.path);
  if (loaded.kind === "loaded" && loaded.config) return { ...loaded.config };
  if (loaded.kind === "missing") return {};
  throw new Error(loaded.error ?? `Unable to load local config at ${project.path}`);
}

export function ensureCollectionContext(project: ProjectConfig): string {
  const contextDir = project.contextDir ?? DEFAULT_CONTEXT_DIR;
  assertRelativeChildPath(contextDir);
  const contextPath = resolve(project.path, contextDir);
  if (!isWithin(resolve(project.path), contextPath)) {
    throw new Error(`Context directory "${contextDir}" escapes project root.`);
  }
  mkdirSync(contextPath, { recursive: true });
  return contextPath;
}

export function listCollectionSubprojects(projectId: string, project: ProjectConfig): SubprojectsList {
  assertCollectionProject(projectId, project);
  ensureCollectionContext(project);

  const rootPath = resolve(project.path);
  const addedEntries = Object.entries(project.repos ?? {}).map(([repoKey, repo]) => {
    const absolutePath = resolve(rootPath, repo.path);
    const detected = existsSync(absolutePath)
      ? detectCandidate(rootPath, absolutePath, true, repoKey)
      : undefined;
    return {
      repoKey,
      name: repo.name ?? detected?.name ?? basename(repo.path),
      path: repo.path,
      absolutePath,
      ...(repo.repo ?? detected?.repo ? { repo: repo.repo ?? detected?.repo } : {}),
      defaultBranch: repo.defaultBranch ?? detected?.defaultBranch ?? "main",
      ...(configWithPlugin(repo.scm) ?? detected?.scm
        ? { scm: configWithPlugin(repo.scm) ?? detected?.scm }
        : {}),
      ...(configWithPlugin(repo.tracker) ?? detected?.tracker
        ? { tracker: configWithPlugin(repo.tracker) ?? detected?.tracker }
        : {}),
      added: true,
    } satisfies SubprojectCandidate;
  });

  const addedByPath = new Map(addedEntries.map((entry) => [entry.path, entry]));
  const available = scanGitRepos(rootPath).filter((candidate) => !addedByPath.has(candidate.path));

  return {
    projectKind: "collection",
    contextDir: project.contextDir ?? DEFAULT_CONTEXT_DIR,
    subprojects: [...addedEntries, ...available].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function addCollectionSubproject(
  projectId: string,
  project: ProjectConfig,
  relativePath: string,
): RepoTargetConfig & { repoKey: string } {
  assertCollectionProject(projectId, project);
  assertRelativeChildPath(relativePath);
  ensureCollectionContext(project);

  const rootPath = resolve(project.path);
  const absolutePath = resolve(rootPath, relativePath);
  if (!isWithin(rootPath, absolutePath)) {
    throw new Error(`Subproject path "${relativePath}" escapes project root.`);
  }
  if (!isGitRepo(absolutePath)) {
    throw new Error(`Subproject path "${relativePath}" is not a git repository.`);
  }

  const currentConfig = loadEditableLocalConfig(project);
  const currentRepos = { ...(currentConfig.repos ?? localReposFromProject(project)) };
  const existing = Object.entries(currentRepos).find(([, repo]) => repo.path === relativePath);
  if (existing) {
    return { repoKey: existing[0], ...(existing[1] as RepoTargetConfig) };
  }

  const candidate = detectCandidate(rootPath, absolutePath, false);
  const repoKey = uniqueRepoKey(candidate.repoKey, currentRepos);
  const repoConfig: LocalRepoConfig = {
    name: candidate.name,
    path: candidate.path,
    defaultBranch: candidate.defaultBranch,
    ...(candidate.repo ? { repo: candidate.repo } : {}),
    ...(configWithPlugin(candidate.scm) ? { scm: configWithPlugin(candidate.scm) } : {}),
    ...(configWithPlugin(candidate.tracker) ? { tracker: configWithPlugin(candidate.tracker) } : {}),
  };

  const currentProfiles = { ...(currentConfig.profiles ?? project.profiles ?? {}) };
  const defaultProfile = new Set(currentProfiles.default ?? Object.keys(currentRepos));
  defaultProfile.add(repoKey);

  writeLocalProjectConfig(project.path, {
    ...currentConfig,
    projectKind: "collection",
    contextDir: currentConfig.contextDir ?? project.contextDir ?? DEFAULT_CONTEXT_DIR,
    workspace: currentConfig.workspace ?? "composite",
    repos: {
      ...currentRepos,
      [repoKey]: repoConfig,
    },
    profiles: {
      ...currentProfiles,
      default: [...defaultProfile],
    },
  });

  return { repoKey, ...repoConfig };
}

export function removeCollectionSubproject(
  projectId: string,
  project: ProjectConfig,
  repoKey: string,
): void {
  assertCollectionProject(projectId, project);
  const currentConfig = loadEditableLocalConfig(project);
  const currentRepos = { ...(currentConfig.repos ?? localReposFromProject(project)) };
  if (!currentRepos[repoKey]) return;

  Reflect.deleteProperty(currentRepos, repoKey);
  const currentProfiles = { ...(currentConfig.profiles ?? project.profiles ?? {}) };
  const nextProfiles = Object.fromEntries(
    Object.entries(currentProfiles).map(([profile, repoKeys]) => [
      profile,
      repoKeys.filter((key) => key !== repoKey),
    ]),
  );

  writeLocalProjectConfig(project.path, {
    ...currentConfig,
    projectKind: "collection",
    contextDir: currentConfig.contextDir ?? project.contextDir ?? DEFAULT_CONTEXT_DIR,
    workspace: currentConfig.workspace ?? "composite",
    repos: currentRepos,
    profiles: {
      ...nextProfiles,
      default: nextProfiles.default ?? Object.keys(currentRepos),
    },
  });
}
