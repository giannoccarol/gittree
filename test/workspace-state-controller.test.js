const test = require('node:test');
const assert = require('node:assert/strict');
let WorkspaceStateController;
try {
  const mod = require('../src/renderer/workspace-state-controller.mts');
  WorkspaceStateController = mod.WorkspaceStateController || mod.default || mod;
} catch {
  WorkspaceStateController = require('../src/renderer/workspace-state-controller');
}

class FakeClassList {
  constructor(values = []) { this.values = new Set(values); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const enabled = force === undefined ? !this.values.has(value) : Boolean(force);
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }
}

class FakeElement {
  constructor({ classes = [], dataset = {} } = {}) {
    this.classList = new FakeClassList(classes);
    this.dataset = { ...dataset };
    this.attributes = {};
    this.listeners = new Map();
    this.children = new Map();
    this.parentElement = null;
    this.title = '';
  }

  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(listener);
  }
  removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
  dispatch(name, event = {}) {
    for (const listener of this.listeners.get(name) || []) listener({
      target: this,
      ...event
    });
  }
  querySelector(selector) { return this.children.get(selector) || null; }
}

function createHarness(initialStorage = {}) {
  const calls = [];
  const elements = new Map();
  const add = (id, element = new FakeElement()) => {
    elements.set(id, element);
    return element;
  };
  const workspace = add('workspace-body');
  const inspector = add('detail-panel');
  const toggleInspector = add('btn-toggle-inspector');
  add('btn-close-inspector');
  const maximizeInspector = add('btn-maximize-inspector');
  maximizeInspector.children.set('i', new FakeElement());
  add('btn-toggle-sidebar');
  add('btn-collapse-sidebar');
  const mainView = add('main-view');
  const changesView = add('changes-view');
  const pullRequestsView = add('pull-requests-view');
  const globalSearch = add('global-search');
  const eyebrow = new FakeElement();
  const heading = new FakeElement();
  const title = add('workspace-title');
  title.children.set('.eyebrow', eyebrow);
  title.children.set('h2', heading);
  const detailHeader = new FakeElement();
  const modeButtons = ['history', 'changes', 'pullRequests'].map(mode => (
    new FakeElement({ dataset: { workspaceMode: mode } })
  ));
  const sectionBody = new FakeElement({ classes: ['collapsed'] });
  const sectionArrow = new FakeElement();
  const section = new FakeElement({ dataset: { section: 'tags' } });
  section.children.set('.sidebar-section-body', sectionBody);
  const sectionHeader = new FakeElement({ classes: ['sidebar-section-header', 'collapsible'] });
  sectionHeader.parentElement = section;
  sectionHeader.children.set('.collapse-arrow', sectionArrow);

  const document = {
    getElementById: id => elements.get(id) || null,
    querySelector: selector => selector === '.detail-panel-header' ? detailHeader : null,
    querySelectorAll(selector) {
      if (selector === '[data-workspace-mode]') return modeButtons;
      if (selector === '.sidebar-section-header.collapsible') return [sectionHeader];
      return [];
    }
  };
  const values = new Map(Object.entries(initialStorage));
  const storage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem(key, value) {
      calls.push(['storage', key, value]);
      values.set(key, value);
    }
  };
  const panelMotion = {
    transition(name, options) {
      calls.push(['motion', name, options.opening, options.animate]);
      options.applyState();
    }
  };
  let nextTimer = 1;
  const timers = new Map();
  const controller = new WorkspaceStateController({
    document,
    storage,
    translate: key => `translated:${key}`,
    panelMotion,
    state: { repo: { path: 'C:\\repo' } },
    components: {
      changes: { setActive: active => calls.push(['changes', active]) },
      pullRequests: { setActive: active => calls.push(['pullRequests', active]) },
      diffViewer: { setInspectorExpanded: expanded => calls.push(['diff', expanded]) }
    },
    viewportWidth: () => 1280,
    computedStyle: () => ({ display: inspector.dataset.display || 'block' }),
    setTimer(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: id => timers.delete(id),
    onModeChange: mode => calls.push(['mode', mode]),
    onInspectorStateChange: state => calls.push(['inspector', state])
  });
  return {
    controller,
    calls,
    values,
    timers,
    document,
    elements,
    workspace,
    inspector,
    toggleInspector,
    maximizeInspector,
    modeButtons,
    mainView,
    changesView,
    pullRequestsView,
    globalSearch,
    eyebrow,
    heading,
    sectionHeader,
    sectionBody,
    sectionArrow,
    detailHeader
  };
}

test('workspace modes update one visible surface and persist per repository', () => {
  const harness = createHarness();
  const { controller, calls, modeButtons, mainView, changesView, pullRequestsView,
    globalSearch, eyebrow, heading, values } = harness;

  controller.setMode('changes');

  assert.equal(controller.mode, 'changes');
  assert.equal(mainView.classList.contains('is-hidden'), true);
  assert.equal(changesView.classList.contains('is-hidden'), false);
  assert.equal(pullRequestsView.classList.contains('is-hidden'), true);
  assert.equal(globalSearch.classList.contains('is-hidden'), true);
  assert.deepEqual(modeButtons.map(button => button.attributes['aria-selected']), ['false', 'true', 'false']);
  assert.equal(eyebrow.dataset.i18n, 'changes.eyebrow');
  assert.equal(heading.dataset.i18n, 'changes.title');
  assert.equal(heading.textContent, 'translated:changes.title');
  assert.equal(values.get('gittree.workspace.mode:C:\\repo'), 'changes');
  assert.ok(calls.some(call => call[0] === 'changes' && call[1] === true));

  controller.setMode('invalid', false);
  assert.equal(controller.mode, 'history');
  assert.equal(mainView.classList.contains('is-hidden'), false);
});

test('sidebar state preserves panel motion, accessibility and persistence', () => {
  const { controller, workspace, elements, calls, values } = createHarness();

  controller.setSidebarCollapsed(true);

  assert.equal(workspace.classList.contains('sidebar-collapsed'), true);
  assert.equal(elements.get('btn-toggle-sidebar').attributes['aria-pressed'], 'false');
  assert.deepEqual(calls.find(call => call[0] === 'motion'), ['motion', 'sidebar', false, true]);
  assert.equal(values.get('gittree.sidebar.collapsed'), 'true');

  calls.length = 0;
  controller.setSidebarCollapsed(true, false);
  assert.deepEqual(calls.find(call => call[0] === 'motion'), ['motion', 'sidebar', false, false]);
});

test('inspector state keeps responsive visibility, icons and restore motion', () => {
  const { controller, workspace, toggleInspector, maximizeInspector, calls, timers, values } = createHarness();

  controller.setInspectorState('maximized');
  assert.equal(controller.inspectorState, 'maximized');
  assert.equal(workspace.classList.contains('inspector-maximized'), true);
  assert.equal(toggleInspector.attributes['aria-pressed'], 'true');
  assert.equal(maximizeInspector.querySelector('i').className, 'ph ph-arrows-in-simple');
  assert.equal(maximizeInspector.dataset.i18nTitle, 'details.restore');
  assert.equal(values.get('gittree.workspace.inspector'), 'maximized');
  assert.ok(calls.some(call => call[0] === 'diff' && call[1] === true));

  controller.setInspectorState('open');
  assert.equal(workspace.classList.contains('is-restoring'), true);
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  assert.equal(workspace.classList.contains('is-restoring'), false);

  controller.setInspectorState('unknown', false);
  assert.equal(controller.inspectorState, 'open');
});

test('mount restores state, binds interactions once and destroy removes every listener', () => {
  const harness = createHarness({
    'gittree.workspace.inspector': 'closed',
    'gittree.sidebar.collapsed': 'true',
    'gittree.sidebar.sections': '["tags"]',
    'gittree.workspace.mode:C:\\repo': 'pullRequests'
  });
  const { controller, workspace, elements, inspector, sectionHeader, sectionBody,
    modeButtons, detailHeader, calls } = harness;

  controller.mount();
  controller.mount();

  assert.equal(controller.inspectorState, 'closed');
  assert.equal(controller.mode, 'history');
  assert.equal(workspace.classList.contains('sidebar-collapsed'), true);
  assert.equal(sectionBody.classList.contains('collapsed'), true);
  assert.equal(sectionHeader.attributes['aria-expanded'], 'false');
  assert.equal(modeButtons[0].listeners.get('click').size, 1);

  modeButtons[2].dispatch('click');
  assert.equal(controller.mode, 'pullRequests');
  elements.get('btn-toggle-sidebar').dispatch('click');
  assert.equal(workspace.classList.contains('sidebar-collapsed'), false);

  controller.setInspectorState('open', false);
  inspector.dataset.display = 'none';
  elements.get('btn-toggle-inspector').dispatch('click');
  assert.equal(controller.inspectorState, 'maximized');
  detailHeader.dispatch('dblclick', { target: { closest: () => null } });
  assert.equal(controller.inspectorState, 'open');

  sectionHeader.dispatch('click');
  assert.equal(sectionBody.classList.contains('collapsed'), false);
  assert.ok(calls.some(call => call[1] === 'gittree.sidebar.sections'));

  controller.destroy();
  assert.equal(modeButtons[0].listeners.get('click').size, 0);
  assert.equal(elements.get('btn-toggle-sidebar').listeners.get('click').size, 0);
  assert.equal(detailHeader.listeners.get('dblclick').size, 0);
});
