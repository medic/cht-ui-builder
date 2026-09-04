import { session } from '../api.js';
import { isAnyDirty, useApp } from '../state/store.js';

export function Sidebar() {
  const project = useApp((s) => s.project);
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const setProject = useApp((s) => s.setProject);
  const dirty = useApp((s) => s.dirty);
  const hasUnsaved = isAnyDirty(dirty);

  if (!project) return null;

  function nav(target: typeof view): void {
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
    // Closing is a per-tab act: this tab forgets its project id. Other tabs
    // keep whatever they have open.
    session.setProjectId(null);
    setProject(null);
  }

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
        <NavItem
          label="Hierarchy"
          active={view.kind === 'hierarchy'}
          onClick={() => nav({ kind: 'hierarchy' })}
          disabled={!project.hasAppSettings}
        />
        <NavItem
          label="Forms"
          active={view.kind === 'forms-index' || view.kind === 'form' || view.kind === 'flowchart'}
          onClick={() => nav({ kind: 'forms-index' })}
        />
        <NavItem
          label="Tasks"
          active={view.kind === 'tasks'}
          onClick={() => nav({ kind: 'tasks' })}
          disabled={!project.hasTasks}
        />
        <NavItem
          label="Contact summary"
          active={view.kind === 'contact-summary'}
          onClick={() => nav({ kind: 'contact-summary' })}
          disabled={!project.hasContactSummary}
        />
        <NavItem
          label="Translations"
          active={view.kind === 'translations'}
          onClick={() => nav({ kind: 'translations' })}
        />
        <NavItem
          label="Decisions (sign-off)"
          active={view.kind === 'decisions'}
          onClick={() => nav({ kind: 'decisions' })}
        />
        <NavItem
          label="Deploy"
          active={view.kind === 'deploy'}
          onClick={() => nav({ kind: 'deploy' })}
        />
        {/* V1 Standard codes — gated on "project has app forms" per the
            FHIR V1 plan (no app forms → nothing to map → disable). The
            workbench is the single place codes are assigned. */}
        <NavItem
          label="Standard codes"
          active={view.kind === 'standard-codes'}
          onClick={() => nav({ kind: 'standard-codes' })}
          disabled={!project.hasAppForms}
        />
      </nav>
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
