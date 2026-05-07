"use client";

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import { ToastProvider, useToast } from "@/components/Toast";
import { SubprojectsSettings } from "@/components/SubprojectsSettings";

const IDENTITY_FIELD_TOOLTIP =
  "These describe which repo this is. Change them via `ao project relink`.";

interface ProjectSettingsFormProps {
  projectId: string;
  projectKind: "repo" | "collection";
  initialValues: {
    agent: string;
    runtime: string;
    orchestratorAgent: string;
    workerAgent: string;
    workerModel: string;
    workerReasoningEffort: string;
    orchestrationMode: "delegate_only" | "coordinate" | "off";
    defaultSubagent: string;
    subagents: SubagentProfileFormState[];
    trackerPlugin: string;
    scmPlugin: string;
    reactions: string;
    identity: {
      projectId: string;
      path: string;
      repo: string;
      defaultBranch: string;
    };
  };
}

interface SubagentProfileFormState {
  name: string;
  agent: string;
  model: string;
  reasoningEffort: string;
  permissions: string;
  description: string;
  repos: string;
}

interface SettingsOptions {
  agents: string[];
  runtimes: string[];
  trackers: string[];
  scms: string[];
  reasoningEfforts: string[];
  permissions: string[];
  modelsByAgent: Record<string, string[]>;
  orchestrationModes: Array<"delegate_only" | "coordinate" | "off">;
}

function ProjectSettingsFormInner({ projectId, projectKind, initialValues }: ProjectSettingsFormProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [agent, setAgent] = useState(initialValues.agent ?? "");
  const [runtime, setRuntime] = useState(initialValues.runtime ?? "");
  const [orchestratorAgent, setOrchestratorAgent] = useState(initialValues.orchestratorAgent ?? "");
  const [workerAgent, setWorkerAgent] = useState(initialValues.workerAgent ?? "");
  const [workerModel, setWorkerModel] = useState(initialValues.workerModel ?? "");
  const [workerReasoningEffort, setWorkerReasoningEffort] = useState(
    initialValues.workerReasoningEffort ?? "",
  );
  const [orchestrationMode, setOrchestrationMode] = useState(
    initialValues.orchestrationMode ?? "coordinate",
  );
  const [defaultSubagent, setDefaultSubagent] = useState(initialValues.defaultSubagent ?? "");
  const [subagents, setSubagents] = useState<SubagentProfileFormState[]>(
    initialValues.subagents ?? [],
  );
  const [trackerPlugin, setTrackerPlugin] = useState(initialValues.trackerPlugin ?? "");
  const [scmPlugin, setScmPlugin] = useState(initialValues.scmPlugin ?? "");
  const [reactions, setReactions] = useState(initialValues.reactions ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [settingsOptions, setSettingsOptions] = useState<SettingsOptions | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/settings-options")
      .then(async (response) => {
        if (!response.ok) throw new Error("Failed to load settings options.");
        return (await response.json()) as SettingsOptions;
      })
      .then((options) => {
        if (!cancelled) setSettingsOptions(options);
      })
      .catch(() => {
        if (!cancelled) setSettingsOptions(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const workerModelOptions = modelOptionsFor(settingsOptions, workerAgent, workerModel);

  const behaviorPayload = useMemo(
    () => {
      const compactSubagents = Object.fromEntries(
        subagents
          .filter((profile) => profile.name.trim() && profile.agent.trim())
          .map((profile) => {
            const repos = profile.repos
              .split(",")
              .map((repo) => repo.trim())
              .filter(Boolean);
            return [
              profile.name.trim(),
              {
                agent: profile.agent.trim(),
                description: profile.description.trim() || undefined,
                repos: repos.length > 0 ? repos : undefined,
                agentConfig: compactObject({
                  model: profile.model.trim() || undefined,
                  reasoningEffort: profile.reasoningEffort.trim() || undefined,
                  permissions: profile.permissions.trim() || undefined,
                }),
              },
            ];
          }),
      );
      return {
        agent: agent.trim() || null,
        runtime: runtime.trim() || null,
        orchestrator: compactObject({ agent: orchestratorAgent.trim() || undefined }),
        worker: compactObject({
          agent: workerAgent.trim() || undefined,
          agentConfig: compactObject({
            model: workerModel.trim() || undefined,
            reasoningEffort: workerReasoningEffort.trim() || undefined,
          }),
        }),
        orchestration:
          orchestrationMode !== "coordinate" ||
          defaultSubagent.trim() ||
          Object.keys(compactSubagents).length > 0
            ? compactObject({
                mode: orchestrationMode,
                defaultSubagent: defaultSubagent.trim() || undefined,
                subagents: Object.keys(compactSubagents).length > 0 ? compactSubagents : undefined,
              })
            : undefined,
        tracker: trackerPlugin.trim() ? { plugin: trackerPlugin.trim() } : null,
        scm: scmPlugin.trim() ? { plugin: scmPlugin.trim() } : null,
        reactions,
      };
    },
    [
      agent,
      runtime,
      orchestratorAgent,
      workerAgent,
      workerModel,
      workerReasoningEffort,
      orchestrationMode,
      defaultSubagent,
      subagents,
      trackerPlugin,
      scmPlugin,
      reactions,
    ],
  );

  const submit = async () => {
    setInlineError(null);
    setNetworkError(null);

    let parsedReactions: Record<string, unknown> | undefined;
    try {
      const trimmed = reactions.trim();
      parsedReactions = trimmed ? (JSON.parse(trimmed) as Record<string, unknown>) : undefined;
    } catch {
      setInlineError("Reactions must be valid JSON.");
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: behaviorPayload.agent,
          runtime: behaviorPayload.runtime,
          orchestrator: behaviorPayload.orchestrator,
          worker: behaviorPayload.worker,
          orchestration: behaviorPayload.orchestration,
          tracker: behaviorPayload.tracker,
          scm: behaviorPayload.scm,
          reactions: parsedReactions ?? null,
        }),
      });

      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        const errorMessage = body?.error ?? "Failed to save project settings.";
        if (response.status === 400) {
          setInlineError(errorMessage);
        } else {
          setNetworkError(errorMessage);
        }
        return;
      }

      showToast("Project settings updated.", "success");
      router.refresh();
    } catch {
      setNetworkError("Network error while saving project settings.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="project-settings-form">
      <section className="project-settings-form__section">
        <div className="project-settings-form__section-header">
          <div>
            <p className="project-settings-form__eyebrow">
              Behavior
            </p>
            <h2 className="project-settings-form__section-title">Runtime configuration</h2>
            <p className="project-settings-form__section-copy">
              These values change how AO runs this project without changing which repository the project points at.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            className="project-settings-form__save"
          >
            {submitting ? "Saving..." : "Save changes"}
          </button>
        </div>

        <div className="project-settings-form__grid">
          <EditableField
            id="agent"
            label="Agent"
            value={agent}
            onChange={setAgent}
            placeholder="claude-code"
            options={settingsOptions?.agents}
          />
          <EditableField
            id="runtime"
            label="Runtime"
            value={runtime}
            onChange={setRuntime}
            placeholder="tmux"
            options={settingsOptions?.runtimes}
          />
          <EditableField
            id="tracker-plugin"
            label="Tracker plugin"
            value={trackerPlugin}
            onChange={setTrackerPlugin}
            placeholder="github"
            options={settingsOptions?.trackers}
          />
          <EditableField
            id="scm-plugin"
            label="SCM plugin"
            value={scmPlugin}
            onChange={setScmPlugin}
            placeholder="github"
            options={settingsOptions?.scms}
          />
        </div>

        <div className="project-settings-form__subsection">
          <p className="project-settings-form__eyebrow">Orchestration</p>
          <h3 className="project-settings-form__subsection-title">Delegation policy</h3>
          <div className="project-settings-form__grid">
            <EditableField
              id="orchestrator-agent"
              label="Orchestrator agent"
              value={orchestratorAgent}
              onChange={setOrchestratorAgent}
              placeholder="claude-code"
              options={settingsOptions?.agents}
            />
            <EditableField
              id="worker-agent"
              label="Default worker harness"
              value={workerAgent}
              onChange={setWorkerAgent}
              placeholder="codex"
              options={settingsOptions?.agents}
            />
            <EditableField
              id="worker-model"
              label="Default worker model"
              value={workerModel}
              onChange={setWorkerModel}
              placeholder="gpt-5.5"
              options={workerModelOptions}
            />
            <EditableField
              id="worker-reasoning"
              label="Default worker reasoning"
              value={workerReasoningEffort}
              onChange={setWorkerReasoningEffort}
              placeholder="low"
              options={settingsOptions?.reasoningEfforts}
            />
            <label htmlFor="orchestration-mode" className="project-settings-form__field">
              <span className="project-settings-form__label">Mode</span>
              <select
                id="orchestration-mode"
                value={orchestrationMode}
                onChange={(event) => setOrchestrationMode(event.target.value as typeof orchestrationMode)}
                className="project-settings-form__input"
              >
                {(settingsOptions?.orchestrationModes ?? ["delegate_only", "coordinate", "off"]).map((mode) => (
                  <option key={mode} value={mode}>{mode}</option>
                ))}
              </select>
            </label>
            <EditableField
              id="default-subagent"
              label="Default worker profile"
              value={defaultSubagent}
              onChange={setDefaultSubagent}
              placeholder="codex-low"
            />
          </div>
        </div>

        <div className="project-settings-form__subsection">
          <div className="project-settings-form__section-header project-settings-form__section-header--compact">
            <div>
              <p className="project-settings-form__eyebrow">Worker Profiles</p>
              <h3 className="project-settings-form__subsection-title">Subagents</h3>
            </div>
            <button
              type="button"
              className="project-settings-form__retry"
              onClick={() =>
                setSubagents((current) => [
                  ...current,
                  {
                    name: `worker-${current.length + 1}`,
                    agent: "codex",
                    model: "gpt-5.5",
                    reasoningEffort: "low",
                    permissions: "permissionless",
                    description: "",
                    repos: "",
                  },
                ])
              }
            >
              Add profile
            </button>
          </div>
          <div className="subagent-profile-list">
            {subagents.map((profile, index) => (
              <div className="subagent-profile" key={`${profile.name}-${index}`}>
                <div className="project-settings-form__grid">
                  <EditableField
                    id={`subagent-${index}-name`}
                    label="Profile"
                    value={profile.name}
                    onChange={(value) => updateSubagent(index, "name", value, setSubagents)}
                    placeholder="codex-low"
                  />
                  <EditableField
                    id={`subagent-${index}-agent`}
                    label="Harness"
                    value={profile.agent}
                    onChange={(value) => updateSubagent(index, "agent", value, setSubagents)}
                    placeholder="codex"
                    options={settingsOptions?.agents}
                  />
                  <EditableField
                    id={`subagent-${index}-model`}
                    label="Model"
                    value={profile.model}
                    onChange={(value) => updateSubagent(index, "model", value, setSubagents)}
                    placeholder="gpt-5.5"
                    options={modelOptionsFor(settingsOptions, profile.agent, profile.model)}
                  />
                  <EditableField
                    id={`subagent-${index}-reasoning`}
                    label="Reasoning"
                    value={profile.reasoningEffort}
                    onChange={(value) => updateSubagent(index, "reasoningEffort", value, setSubagents)}
                    placeholder="low"
                    options={settingsOptions?.reasoningEfforts}
                  />
                  <EditableField
                    id={`subagent-${index}-permissions`}
                    label="Permissions"
                    value={profile.permissions}
                    onChange={(value) => updateSubagent(index, "permissions", value, setSubagents)}
                    placeholder="permissionless"
                    options={settingsOptions?.permissions}
                  />
                  <EditableField
                    id={`subagent-${index}-repos`}
                    label="Repos"
                    value={profile.repos}
                    onChange={(value) => updateSubagent(index, "repos", value, setSubagents)}
                    placeholder="api-go,front-react"
                  />
                </div>
                <label htmlFor={`subagent-${index}-description`} className="project-settings-form__field">
                  <span className="project-settings-form__label">Description</span>
                  <input
                    id={`subagent-${index}-description`}
                    value={profile.description}
                    onChange={(event) => updateSubagent(index, "description", event.target.value, setSubagents)}
                    className="project-settings-form__input"
                  />
                </label>
                <button
                  type="button"
                  className="project-settings-form__retry"
                  onClick={() => setSubagents((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                >
                  Remove profile
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="project-settings-form__reactions">
          <label htmlFor="reactions" className="project-settings-form__label">
            Reactions
          </label>
          <p className="project-settings-form__hint">
            JSON object keyed by reaction name. This PATCH only sends behavior fields.
          </p>
          <textarea
            id="reactions"
            value={reactions}
            onChange={(event) => setReactions(event.target.value)}
            spellCheck={false}
            rows={12}
            className="project-settings-form__textarea project-settings-form__textarea--mono"
          />
        </div>

        {inlineError ? (
          <div
            role="alert"
            className="project-settings-form__alert project-settings-form__alert--error"
          >
            {inlineError}
          </div>
        ) : null}

        {networkError ? (
          <div className="project-settings-form__alert project-settings-form__alert--surface">
            <p className="project-settings-form__alert-copy">{networkError}</p>
            <button
              type="button"
              onClick={() => void submit()}
              className="project-settings-form__retry"
            >
              Retry
            </button>
          </div>
        ) : null}
      </section>

      {projectKind === "collection" ? <SubprojectsSettings projectId={projectId} /> : null}

      <section className="project-settings-form__section">
        <p className="project-settings-form__eyebrow">
          Identity
        </p>
        <h2 className="project-settings-form__section-title">Repository identity</h2>
        <p className="project-settings-form__section-copy">
          These fields are read-only because they define which repository AO considers this project to be.
        </p>

        <div className="project-settings-form__grid">
          <ReadonlyField id="identity-project-id" label="Project ID" value={initialValues.identity.projectId} />
          <ReadonlyField id="identity-path" label="Path" value={initialValues.identity.path} />
          <ReadonlyField id="identity-repo" label="Repo" value={initialValues.identity.repo} />
          <ReadonlyField
            id="identity-default-branch"
            label="Default branch"
            value={initialValues.identity.defaultBranch}
          />
        </div>
      </section>
    </div>
  );
}

function updateSubagent(
  index: number,
  field: keyof SubagentProfileFormState,
  value: string,
  setSubagents: Dispatch<SetStateAction<SubagentProfileFormState[]>>,
) {
  setSubagents((current) =>
    current.map((profile, itemIndex) =>
      itemIndex === index ? { ...profile, [field]: value } : profile,
    ),
  );
}

function compactObject<T extends Record<string, unknown>>(input: T): T | undefined {
  const output = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as T;
  return Object.keys(output).length > 0 ? output : undefined;
}

function EditableField({
  id,
  label,
  value,
  onChange,
  placeholder,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  options?: string[];
}) {
  const normalizedOptions = mergeCurrentOption(options, value);
  if (normalizedOptions.length > 0) {
    return (
      <label htmlFor={id} className="project-settings-form__field">
        <span className="project-settings-form__label">{label}</span>
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="project-settings-form__input"
        >
          <option value="">Select...</option>
          {normalizedOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label htmlFor={id} className="project-settings-form__field">
      <span className="project-settings-form__label">{label}</span>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="project-settings-form__input"
      />
    </label>
  );
}

function mergeCurrentOption(options: string[] | undefined, current: string): string[] {
  const values = [...(options ?? [])];
  const trimmed = current.trim();
  if (trimmed && !values.includes(trimmed)) values.push(trimmed);
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function modelOptionsFor(
  options: SettingsOptions | null,
  agentName: string,
  current: string,
): string[] {
  const key = agentName.trim();
  return mergeCurrentOption(key ? options?.modelsByAgent[key] : undefined, current);
}

function ReadonlyField({
  id,
  label,
  value,
}: {
  id: string;
  label: string;
  value: string;
}) {
  return (
    <label htmlFor={id} className="project-settings-form__field">
      <span className="project-settings-form__label">{label}</span>
      <input
        id={id}
        value={value}
        disabled
        readOnly
        title={IDENTITY_FIELD_TOOLTIP}
        aria-describedby={`${id}-tooltip`}
        className="project-settings-form__input project-settings-form__input--readonly"
      />
      <span id={`${id}-tooltip`} className="project-settings-form__hint">
        {IDENTITY_FIELD_TOOLTIP}
      </span>
    </label>
  );
}

export function ProjectSettingsForm(props: ProjectSettingsFormProps) {
  return (
    <ToastProvider>
      <ProjectSettingsFormInner {...props} />
    </ToastProvider>
  );
}
