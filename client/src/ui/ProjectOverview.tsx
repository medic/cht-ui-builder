/**
 * Project overview — the cards that route to each editor.
 *
 * Onboarding guardrails (docs/plans/onboarding-order.md §5/§6):
 *   - Recommended order: hierarchy → contact forms → app forms → tasks.
 *   - When `contact_types` is empty (the silent-fallback trap CHT runs
 *     with), surface a "start with Hierarchy" nudge at the top — guide,
 *     don't gate. Decision 2 keeps the new-project picker as-is.
 */
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../state/store.js';
import { ProjectTransfer } from './ProjectTransfer.js';

export function ProjectOverview() {
  const project = useApp((s) => s.project);
  const setView = useApp((s) => s.setView);
  // Hiding a tab in the sidebar has to hide its doorway here too, or the
  // landing page keeps inviting you into a section you just put away. Ids
  // match `TABS` in Sidebar.tsx.
  const hiddenTabs = useApp((s) => s.hiddenTabs);
  // Recommend-order hint state. Fetched once per overview mount; an
  // empty contact_types array means the project is on CHT's silent
  // legacy-default hierarchy fallback, which the author probably
  // doesn't want unless they explicitly chose it.
  const [contactTypesCount, setContactTypesCount] = useState<number | null>(null);

  useEffect(() => {
    if (!project) return;
    let alive = true;
    void api
      .getHierarchy()
      .then((h) => {
        if (alive) setContactTypesCount(h.contact_types.length);
      })
      .catch(() => {
        if (alive) setContactTypesCount(null);
      });
    return () => {
      alive = false;
    };
  }, [project]);

  if (!project) return null;
  const hierarchyEmpty = contactTypesCount === 0;

  return (
    <div className="overview">
      <h1>{project.name}</h1>
      {project.path && <code className="path">{project.path}</code>}
      <p>This is a cht-conf project. Pick a section to start editing.</p>

      {/* Onboarding nudge — only shows on a fresh / hierarchy-empty
          project. Non-blocking; the cards below are still clickable. */}
      {hierarchyEmpty && !hiddenTabs.has('hierarchy') && (
        <div className="onboarding-nudge">
          <strong>👋 Start with Hierarchy</strong>
          <p>
            No contact types are defined yet. CHT will run on its legacy
            default hierarchy (<code>district_hospital → health_center → clinic → person</code>),
            but any form referencing an undefined type (<code>select-contact type-X</code>,
            lineage, task <code>appliesToType</code>) will <strong>silently fail</strong> at
            runtime. Define your hierarchy first.
          </p>
          <p className="muted small">
            Recommended order: <strong>Hierarchy → Contact forms → App forms → Tasks.</strong>
          </p>
          <button
            type="button"
            className="primary"
            onClick={() => setView({ kind: 'hierarchy' })}
          >
            Open Hierarchy →
          </button>
        </div>
      )}

      <div className="overview-grid">
        {!hiddenTabs.has('hierarchy') && (
          <OverviewCard
            title="Hierarchy"
            desc="Contact types and place hierarchy."
            available={project.hasAppSettings}
            recommended={hierarchyEmpty}
            onClick={() => setView({ kind: 'hierarchy' })}
          />
        )}
        {!hiddenTabs.has('forms') && (
          <OverviewCard
            title="Forms"
            desc="Edit or create app forms and contact forms."
            available={project.hasAppForms || project.hasContactForms}
            onClick={() => setView({ kind: 'forms-index' })}
          />
        )}
        {!hiddenTabs.has('tasks') && (
          <OverviewCard
            title="Tasks"
            desc="Edit task definitions and schedules."
            available={project.hasTasks}
            onClick={() => setView({ kind: 'tasks' })}
          />
        )}
        {!hiddenTabs.has('contact-summary') && (
          <OverviewCard
            title="Contact summary"
            desc="Edit the context flags forms depend on."
            available={project.hasContactSummary}
            onClick={() => setView({ kind: 'contact-summary' })}
          />
        )}
      </div>

      <ProjectTransfer />
    </div>
  );
}

function OverviewCard(props: {
  title: string;
  desc: string;
  available: boolean;
  /** Highlight as the recommended next step (used by the onboarding
   *  nudge to draw the user to the Hierarchy card). */
  recommended?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`overview-card ${props.available ? '' : 'disabled'}${props.recommended ? ' recommended' : ''}`}
      onClick={props.onClick}
      disabled={!props.available}
    >
      <strong>{props.title}</strong>
      <span>{props.desc}</span>
      {props.recommended && <em className="recommended-badge">Start here →</em>}
      {!props.available && <em>missing from this project</em>}
    </button>
  );
}
