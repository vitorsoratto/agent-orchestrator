import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addCollectionSubproject,
  listCollectionSubprojects,
  removeCollectionSubproject,
} from "../subprojects.js";
import { loadLocalProjectConfig } from "../global-config.js";
import type { ProjectConfig } from "../types.js";

let rootDir: string;
let project: ProjectConfig;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initRepo(relativePath: string): void {
  const repoPath = join(rootDir, relativePath);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", "dev"]);
  git(repoPath, ["config", "user.email", "ao@example.com"]);
  git(repoPath, ["config", "user.name", "AO Test"]);
  execFileSync("sh", ["-c", "echo test > README.md"], { cwd: repoPath, stdio: "ignore" });
  git(repoPath, ["add", "README.md"]);
  git(repoPath, ["commit", "-m", "init"]);
  git(repoPath, ["remote", "add", "origin", `git@github.com:org/${relativePath}.git`]);
}

beforeEach(() => {
  rootDir = join(tmpdir(), `ao-subprojects-${randomUUID()}`);
  mkdirSync(rootDir, { recursive: true });
  initRepo("api-go");
  initRepo("front-react");

  project = {
    name: "Dotelematics",
    projectKind: "collection",
    path: rootDir,
    defaultBranch: "main",
    sessionPrefix: "dot",
    workspace: "composite",
    contextDir: ".ao/context",
    repos: {},
    profiles: { default: [] },
  };
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe("collection subprojects", () => {
  it("lists available git subfolders and adds/removes without deleting repos", () => {
    const initial = listCollectionSubprojects("dot", project);

    expect(initial.subprojects.map((subproject) => subproject.path)).toEqual([
      "api-go",
      "front-react",
    ]);
    expect(initial.subprojects.every((subproject) => !subproject.added)).toBe(true);

    const added = addCollectionSubproject("dot", project, "api-go");
    expect(added.repoKey).toBe("api-go");
    expect(added.repo).toBe("org/api-go");

    const config = loadLocalProjectConfig(rootDir);
    expect(config?.repos?.["api-go"]?.path).toBe("api-go");
    expect(config?.profiles?.default).toEqual(["api-go"]);

    project = {
      ...project,
      repos: config?.repos,
      profiles: config?.profiles,
    };

    removeCollectionSubproject("dot", project, "api-go");
    const removed = loadLocalProjectConfig(rootDir);
    expect(removed?.repos?.["api-go"]).toBeUndefined();
    expect(removed?.profiles?.default).toEqual([]);

    expect(() => listCollectionSubprojects("dot", { ...project, repos: {}, profiles: { default: [] } })).not.toThrow();
  });
});
