"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

interface SubprojectRow {
  repoKey: string;
  name: string;
  path: string;
  absolutePath: string;
  repo?: string;
  defaultBranch: string;
  scm?: { plugin: string };
  tracker?: { plugin: string };
  added: boolean;
}

interface SubprojectsResponse {
  projectKind: "repo" | "collection";
  contextDir: string;
  subprojects: SubprojectRow[];
}

interface SubprojectsSettingsProps {
  projectId: string;
}

export function SubprojectsSettings({ projectId }: SubprojectsSettingsProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [actingPath, setActingPath] = useState<string | null>(null);
  const [data, setData] = useState<SubprojectsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const addedCount = useMemo(
    () => data?.subprojects.filter((subproject) => subproject.added).length ?? 0,
    [data],
  );

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/subprojects`);
      const body = (await response.json().catch(() => null)) as
        | (SubprojectsResponse & { error?: string })
        | null;
      if (!response.ok) {
        setError(body?.error ?? "Failed to load subprojects.");
        return;
      }
      setData(body);
    } catch {
      setError("Network error while loading subprojects.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [projectId]);

  const addSubproject = async (path: string) => {
    setActingPath(path);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/subprojects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(body?.error ?? "Failed to add subproject.");
        return;
      }
      await load();
      router.refresh();
    } catch {
      setError("Network error while adding subproject.");
    } finally {
      setActingPath(null);
    }
  };

  const removeSubproject = async (repoKey: string) => {
    setActingPath(repoKey);
    setError(null);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/subprojects/${encodeURIComponent(repoKey)}`,
        { method: "DELETE" },
      );
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(body?.error ?? "Failed to remove subproject.");
        return;
      }
      await load();
      router.refresh();
    } catch {
      setError("Network error while removing subproject.");
    } finally {
      setActingPath(null);
    }
  };

  return (
    <section className="project-settings-form__section">
      <div className="project-settings-form__section-header">
        <div>
          <p className="project-settings-form__eyebrow">Collection</p>
          <h2 className="project-settings-form__section-title">Subprojects</h2>
          <p className="project-settings-form__section-copy">
            Repositories below the main project folder. Added subprojects are included in the default workspace profile.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="project-settings-form__save"
        >
          {loading ? "Scanning..." : "Refresh scan"}
        </button>
      </div>

      <div className="project-settings-form__hint">
        Context directory: <code>{data?.contextDir ?? ".ao/context"}</code> · Added: {addedCount}
      </div>

      {error ? (
        <div role="alert" className="project-settings-form__alert project-settings-form__alert--error">
          {error}
        </div>
      ) : null}

      <div className="project-settings-form__subprojects">
        {loading && !data ? (
          <div className="project-settings-form__hint">Scanning subfolders...</div>
        ) : data?.subprojects.length ? (
          data.subprojects.map((subproject) => {
            const actionBusy = actingPath === subproject.path || actingPath === subproject.repoKey;
            return (
              <div key={`${subproject.added ? "added" : "available"}:${subproject.path}`} className="project-settings-form__subproject-row">
                <div>
                  <div className="project-settings-form__label">
                    {subproject.name}{" "}
                    <span className="project-settings-form__hint">
                      {subproject.added ? "added" : "available"}
                    </span>
                  </div>
                  <div className="project-settings-form__hint">
                    <code>{subproject.path}</code>
                    {" · "}
                    {subproject.repo ?? "no remote"}
                    {" · "}
                    {subproject.defaultBranch}
                  </div>
                </div>
                {subproject.added ? (
                  <button
                    type="button"
                    onClick={() => void removeSubproject(subproject.repoKey)}
                    disabled={actionBusy}
                    className="project-settings-form__retry"
                  >
                    {actionBusy ? "Removing..." : "Remove"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void addSubproject(subproject.path)}
                    disabled={actionBusy}
                    className="project-settings-form__save"
                  >
                    {actionBusy ? "Adding..." : "Add"}
                  </button>
                )}
              </div>
            );
          })
        ) : (
          <div className="project-settings-form__hint">No git subfolders found below this project.</div>
        )}
      </div>
    </section>
  );
}
