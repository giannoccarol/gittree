const test = require('node:test');
const assert = require('node:assert/strict');
let WorkspacePanelMotion;
try {
  const mod = require('../src/renderer/workspace-panel-motion.mts');
  WorkspacePanelMotion = mod.WorkspacePanelMotion || mod.default || mod;
} catch {
  WorkspacePanelMotion = require('../src/renderer/workspace-panel-motion');
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
}

class FakeElement {
  constructor() {
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.inert = false;
    this.focused = false;
    this.children = new Set();
  }

  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name) { this.listeners.delete(name); }
  setAttribute(name, value) { this.attributes[name] = value; }
  contains(element) { return this.children.has(element); }
  focus() { this.focused = true; }
  dispatch(name, animationName) {
    this.listeners.get(name)?.({ target: this, animationName });
  }
}

function createHarness({ reduced = false } = {}) {
  const workspace = new FakeElement();
  const panel = new FakeElement();
  const toggle = new FakeElement();
  const activeElement = new FakeElement();
  const motion = new WorkspacePanelMotion({
    workspace,
    document: { activeElement },
    panels: {
      sidebar: {
        panel,
        toggle,
        openingAnimation: 'motion-panel-enter-left',
        closingAnimation: 'motion-panel-exit-left'
      }
    },
    prefersReducedMotion: () => reduced
  });
  return { activeElement, motion, panel, toggle, workspace };
}

test('panel motion applies layout once and exposes an explicit opening lifecycle', () => {
  const { motion, panel, workspace } = createHarness();
  let layoutCommits = 0;

  motion.transition('sidebar', {
    opening: true,
    applyState: () => { layoutCommits += 1; }
  });

  assert.equal(layoutCommits, 1);
  assert.equal(workspace.classList.contains('is-sidebar-opening'), true);
  assert.equal(panel.dataset.motionState, 'opening');
  assert.equal(panel.inert, false);
  assert.equal(panel.attributes['aria-hidden'], 'false');

  panel.dispatch('animationend', 'motion-panel-enter-left');
  assert.equal(workspace.classList.contains('is-sidebar-opening'), false);
  assert.equal(panel.dataset.motionState, 'idle');
});

test('closing a focused panel returns focus and leaves it inert', () => {
  const { activeElement, motion, panel, toggle, workspace } = createHarness();
  panel.children.add(activeElement);

  motion.transition('sidebar', { opening: false, applyState() {} });

  assert.equal(toggle.focused, true);
  assert.equal(panel.inert, true);
  assert.equal(panel.attributes['aria-hidden'], 'true');
  assert.equal(workspace.classList.contains('is-sidebar-closing'), true);
});

test('rapid reversal cancels stale motion classes before starting the next direction', () => {
  const { motion, panel, workspace } = createHarness();

  motion.transition('sidebar', { opening: false, applyState() {} });
  motion.transition('sidebar', { opening: true, applyState() {} });

  assert.equal(workspace.classList.contains('is-sidebar-closing'), false);
  assert.equal(workspace.classList.contains('is-sidebar-opening'), true);
  assert.equal(panel.dataset.motionState, 'opening');
});

test('reduced motion keeps state and accessibility without animation classes', () => {
  const { motion, panel, workspace } = createHarness({ reduced: true });

  motion.transition('sidebar', { opening: false, applyState() {} });

  assert.equal(workspace.classList.contains('is-sidebar-closing'), false);
  assert.equal(panel.dataset.motionState, 'idle');
  assert.equal(panel.inert, true);
});
