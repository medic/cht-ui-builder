/**
 * Project sidebar: the tab rail, plus the panel that chooses which tabs it
 * shows.
 *
 * Teams work on one part of a config at a time — a forms-only push has no use
 * for tasks, sign-off or standard codes taking up the rail. Rather than
 * deleting those tabs, the "Tabs" panel collapses them per browser: the views
 * all still exist, nothing is removed from the project, and a tick box brings
 * any of them straight back.
 *
 * Overview is deliberately not in the list. It is where `setProject` lands and
 * where someone goes after hiding the tab they were on, so it always shows.
 */
import { useState } from 'react';
import { api, session } from '../api.js';
import { isAnyDirty, useApp, type ProjectInfo, type View } from '../state/store.js';

interface TabDef {
  id: string;
  label: string;
  /** Where clicking the tab goes. */
  view: View;
  /** View kinds that mean "this tab is the current one". */
  matches: View['kind'][];
  /** Projects missing the underlying file get the tab greyed out, as before. */
  requires?: (p: ProjectInfo) => boolean;
}

const TABS: TabDef[] = [
  {
    id: 'hierarchy',
    label: 'Hierarchy',
    view: { kind: 'hierarchy' },
    matches: ['hierarchy'],
    requires: (p) => p.hasAppSettings,
  },
  {
    id: 'forms',
    label: 'Forms',
    view: { kind: 'forms-index' },
    matches: ['forms-index', 'form', 'flowchart'],
  },
  {
    id: 'tasks',
    label: 'Tasks',
    view: { kind: 'tasks' },
    matches: ['tasks'],
    requires: (p) => p.hasTasks,
  },
  {
    id: 'contact-summary',
    label: 'Contact summary',
    view: { kind: 'contact-summary' },
    matches: ['contact-summary'],
    requires: (p) => p.hasContactSummary,
  },
  {
    id: 'translations',
    label: 'Translations',
    view: { kind: 'translations' },
    matches: ['translations'],
  },
  {
    id: 'decisions',
    label: 'Decisions (sign-off)',
    view: { kind: 'decisions' },
    matches: ['decisions'],
  },
  {
    id: 'deploy',
    label: 'Deploy',
    view: { kind: 'deploy' },
    matches: ['deploy'],
  },
  // V1 Standard codes — gated on "project has app forms" per the FHIR V1 plan
  // (no app forms → nothing to map → disable). The workbench is the single
  // place codes are assigned.
  {
    id: 'standard-codes',
    label: 'Standard codes',
    view: { kind: 'standard-codes' },
    matches: ['standard-codes'],
    requires: (p) => p.hasAppForms,
  },
];

export function Sidebar() {
  const project = useApp((s) => s.project);
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const setProject = useApp((s) => s.setProject);
  const dirty = useApp((s) => s.dirty);
  const hiddenTabs = useApp((s) => s.hiddenTabs);
  const toggleTab = useApp((s) => s.toggleTab);
  const showAllTabs = useApp((s) => s.showAllTabs);
  const [panelOpen, setPanelOpen] = useState(false);
  const hasUnsaved = isAnyDirty(dirty);

  if (!project) return null;

  function nav(target: View): void {
    if (hasUnsaved) {
      const ok = window.confirm('You have unsaved changes. Discard them?');
      if (!ok) return;
    }
    setView(target);
  }

  function close() {
    if (hasUnsaved) {
      const ok = window.confirm('Close project and discard unsaved changes?');
      if (!ok) return;
    }
    // This tab forgets its project id; other tabs keep whatever they have
    // open. The server call clears desktop mode's "last opened" fallback so a
    // reload lands on the picker, not back inside this project.
    session.setProjectId(null);
    void api.closeProject().catch(() => undefined);
    setProject(null);
  }

  function onToggle(tab: TabDef): void {
    const hiding = !hiddenTabs.has(tab.id);
    toggleTab(tab.id);
    // Don't strand someone on a tab they just hid — but never discard their
    // work to do it. With unsaved edits the view stays put (its content is
    // still rendered, so nothing is lost) and they can leave when ready.
    if (hiding && tab.matches.includes(view.kind) && !hasUnsaved) {
      setView({ kind: 'project-overview' });
    }
  }

  const shown = TABS.filter((t) => !hiddenTabs.has(t.id));
  const hiddenCount = TABS.length - shown.length;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="project-name" title={project.path || project.name}>
          {project.name}
        </div>
        <button className="secondary" onClick={close} title="Close this project and pick another">
          Change project
        </button>
      </div>
      <nav>
        <NavItem
          label="Overview"
          active={view.kind === 'project-overview'}
          onClick={() => nav({ kind: 'project-overview' })}
        />
        {shown.map((tab) => (
          <NavItem
            key={tab.id}
            label={tab.label}
            active={tab.matches.includes(view.kind)}
            onClick={() => nav(tab.view)}
            disabled={tab.requires ? !tab.requires(project) : false}
          />
        ))}
      </nav>

      <div className="tab-panel-wrap">
        <button
          type="button"
          className="link tab-panel-toggle"
          onClick={() => setPanelOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={panelOpen}
          title="Choose which tabs appear in this sidebar"
        >
          ⚙ Tabs{hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}
        </button>
        {panelOpen && (
          <div className="tab-panel" role="dialog" aria-label="Choose which tabs are shown">
            <p className="muted small">
              Hiding a tab only affects this browser. Nothing is removed from the project.
            </p>
            {TABS.map((tab) => (
              <label key={tab.id} className="tab-panel-row">
                <input
                  type="checkbox"
                  checked={!hiddenTabs.has(tab.id)}
                  onChange={() => onToggle(tab)}
                />
                {tab.label}
              </label>
            ))}
            <div className="tab-panel-actions">
              <button type="button" className="link" onClick={showAllTabs} disabled={hiddenCount === 0}>
                Show all
              </button>
              <button type="button" className="link" onClick={() => setPanelOpen(false)}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>

      {hasUnsaved && <div className="dirty-flag">Unsaved changes</div>}
    </aside>
  );
}

function NavItem(props: { label: string; active: boolean; onClick: () => void; disabled?: boolean }) {
  const cls = ['nav-item', props.active ? 'active' : '', props.disabled ? 'disabled' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button className={cls} onClick={props.onClick} disabled={props.disabled}>
      {props.label}
    </button>
  );
}
