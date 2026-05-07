import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type {
  PluginModule,
  Workspace,
  WorkspaceCreateConfig,
  WorkspaceInfo,
  ProjectConfig,
} from "@aoagents/ao-core";

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "composite",
  slot: "workspace" as const,
  description: "Workspace plugin: collection root with per-subproject git worktrees",
  version: "0.1.0",
};

const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9_-]+$/;
const GIT_TIMEOUT = 30_000;

function assertSafePathSegment(value: string, label: string): void {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Invalid ${label} "${value}": must match ${SAFE_PATH_SEGMENT}`);
  }
}

function expandPath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
}

function assertRelativeChildPath(rawPath: string, label: string): void {
  if (!rawPath || rawPath.startsWith("/") || rawPath.split(/[\\/]/).includes("..")) {
    throw new Error(`Invalid ${label} "${rawPath}": must be a relative child path`);
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT });
  return stdout.trimEnd();
}

async function hasOriginRemote(cwd: string): Promise<boolean> {
  try {
    await git(cwd, "remote", "get-url", "origin");
    return true;
  } catch {
    return false;
  }
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

async function resolveBaseRef(
  repoPath: string,
  defaultBranch: string,
  hasOrigin: boolean,
): Promise<string> {
  if (hasOrigin) {
    const remoteDefaultBranch = `origin/${defaultBranch}`;
    if (await refExists(repoPath, remoteDefaultBranch)) return remoteDefaultBranch;
  }

  const localDefaultBranch = `refs/heads/${defaultBranch}`;
  if (await refExists(repoPath, localDefaultBranch)) return localDefaultBranch;

  throw new Error(`Unable to resolve base ref for default branch "${defaultBranch}" in ${repoPath}`);
}

async function isRegisteredWorktree(repoPath: string, worktreePath: string): Promise<boolean> {
  try {
    const output = await git(repoPath, "worktree", "list", "--porcelain");
    return output
      .split("\n")
      .some((line) => line.startsWith("worktree ") && line.slice("worktree ".length) === worktreePath);
  } catch {
    return false;
  }
}

async function clearStaleWorktreePath(repoPath: string, worktreePath: string): Promise<void> {
  if (!existsSync(worktreePath)) return;

  try {
    await git(repoPath, "worktree", "prune");
  } catch {
    // Best effort.
  }

  if (await isRegisteredWorktree(repoPath, worktreePath)) {
    throw new Error(`Worktree path "${worktreePath}" already exists and is still registered with git`);
  }

  rmSync(worktreePath, { recursive: true, force: true });
}

async function addRepoWorktree(args: {
  rootPath: string;
  repoKey: string;
  repoPath: string;
  targetPath: string;
  branch: string;
  defaultBranch: string;
}): Promise<void> {
  assertSafePathSegment(args.repoKey, "repoKey");
  if (!isWithin(args.rootPath, args.targetPath)) {
    throw new Error(`Subproject target escapes composite workspace: ${args.targetPath}`);
  }

  mkdirSync(dirname(args.targetPath), { recursive: true });
  await clearStaleWorktreePath(args.repoPath, args.targetPath);

  const hasOrigin = await hasOriginRemote(args.repoPath);
  if (hasOrigin) {
    try {
      await git(args.repoPath, "fetch", "origin", "--quiet");
    } catch {
      // Offline work is allowed if local refs are sufficient.
    }
  }

  const baseRef = await resolveBaseRef(args.repoPath, args.defaultBranch, hasOrigin);
  try {
    await git(args.repoPath, "worktree", "add", "-b", args.branch, args.targetPath, baseRef);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already exists")) {
      throw new Error(`Failed to create worktree for "${args.repoKey}" on branch "${args.branch}": ${msg}`, {
        cause: err,
      });
    }
    await git(args.repoPath, "worktree", "add", args.targetPath, baseRef);
    await git(args.targetPath, "checkout", args.branch);
  }
}

function selectedRepoKeys(project: ProjectConfig): string[] {
  const repos = project.repos ?? {};
  const profile = project.profiles?.["default"] ?? Object.keys(repos);
  return profile.filter((repoKey) => repos[repoKey]);
}

function ensureContextLink(rootPath: string, project: ProjectConfig): string | undefined {
  const contextDir = project.contextDir ?? ".ao/context";
  assertRelativeChildPath(contextDir, "contextDir");

  const sourcePath = resolve(expandPath(project.path), contextDir);
  mkdirSync(sourcePath, { recursive: true });

  const targetPath = join(rootPath, contextDir);
  mkdirSync(dirname(targetPath), { recursive: true });

  if (existsSync(targetPath)) {
    const stat = lstatSync(targetPath);
    if (stat.isSymbolicLink() || stat.isFile() || stat.isDirectory()) {
      rmSync(targetPath, { recursive: true, force: true });
    }
  }

  symlinkSync(sourcePath, targetPath, "dir");
  return targetPath;
}

async function destroyCompositeWorkspace(workspacePath: string): Promise<void> {
  if (!existsSync(workspacePath)) return;

  const entries = readdirSync(workspacePath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(workspacePath, entry.name);
    try {
      const gitCommonDir = await git(
        candidate,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      );
      const repoPath = resolve(gitCommonDir, "..");
      await git(repoPath, "worktree", "remove", "--force", candidate);
    } catch {
      // Non-git directories (e.g. .ao) are removed with the root below.
    }
  }

  rmSync(workspacePath, { recursive: true, force: true });
}

export function create(): Workspace {
  const workspace: Workspace = {
    name: "composite",

    async create(cfg: WorkspaceCreateConfig): Promise<WorkspaceInfo> {
      assertSafePathSegment(cfg.projectId, "projectId");
      assertSafePathSegment(cfg.sessionId, "sessionId");

      if (cfg.project.projectKind !== "collection") {
        throw new Error("workspace-composite requires projectKind: collection");
      }

      const projectRoot = expandPath(cfg.project.path);
      const repos = cfg.project.repos ?? {};
      const repoKeys = selectedRepoKeys(cfg.project);

      const baseDir = cfg.worktreeDir ?? join(homedir(), ".ao-composite-workspaces", cfg.projectId);
      const rootPath = join(baseDir, cfg.sessionId);
      await destroyCompositeWorkspace(rootPath);
      mkdirSync(rootPath, { recursive: true });

      const repoInfos: NonNullable<WorkspaceInfo["repos"]> = {};
      try {
        for (const repoKey of repoKeys) {
          const repo = repos[repoKey];
          if (!repo) continue;
          assertRelativeChildPath(repo.path, `repos.${repoKey}.path`);

          const repoPath = resolve(projectRoot, repo.path);
          if (!isWithin(projectRoot, repoPath)) {
            throw new Error(`Subproject "${repoKey}" escapes collection root: ${repo.path}`);
          }

          const targetPath = join(rootPath, repo.path);
          await addRepoWorktree({
            rootPath,
            repoKey,
            repoPath,
            targetPath,
            branch: cfg.branch,
            defaultBranch: repo.defaultBranch,
          });
          repoInfos[repoKey] = { path: targetPath, branch: cfg.branch };
        }

        const contextPath = ensureContextLink(rootPath, cfg.project);

        return {
          path: rootPath,
          branch: cfg.branch,
          sessionId: cfg.sessionId,
          projectId: cfg.projectId,
          repos: repoInfos,
          contextPath,
        };
      } catch (err) {
        await destroyCompositeWorkspace(rootPath);
        throw err;
      }
    },

    async destroy(workspacePath: string): Promise<void> {
      await destroyCompositeWorkspace(workspacePath);
    },

    async list(projectId: string): Promise<WorkspaceInfo[]> {
      assertSafePathSegment(projectId, "projectId");
      return [];
    },

    async exists(workspacePath: string): Promise<boolean> {
      return existsSync(workspacePath);
    },

    async restore(cfg: WorkspaceCreateConfig, workspacePath: string): Promise<WorkspaceInfo> {
      await destroyCompositeWorkspace(workspacePath);
      return workspace.create({ ...cfg, worktreeDir: dirname(workspacePath) });
    },
  };
  return workspace;
}

export default { manifest, create } satisfies PluginModule<Workspace>;
