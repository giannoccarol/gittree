const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

let SettingsView;
try {
  const mod = require(path.join(
    __dirname,
    '..',
    'src',
    'renderer',
    'components',
    'settings-view.mts'
  ));
  SettingsView = mod.SettingsView || mod.default || mod;
} catch {
  SettingsView = require(path.join(
    __dirname,
    '..',
    'src',
    'renderer',
    'components',
    'settings-view.js'
  ));
}

function createView(sectionNames) {
  const removed = [];
  const classToggles = [];
  const fullOnly = [
    { remove: () => removed.push('diagnostics-row') },
    { remove: () => removed.push('diagnostics-help') }
  ];
  const sections = sectionNames.map(name => ({
    dataset: { settingsSection: name },
    remove: () => removed.push(name)
  }));
  const view = Object.create(SettingsView.prototype);
  view.dialog = {
    classList: {
      toggle: (name, enabled) => classToggles.push([name, enabled])
    },
    querySelectorAll: selector => {
      if (selector === '[data-settings-section]') return sections;
      assert.equal(selector, '[data-settings-full-only]');
      return fullOnly;
    }
  };
  return { classToggles, removed, view };
}

test('Welcome settings keep only About and update controls', () => {
  const harness = createView(['appearance', 'repository', 'about']);

  harness.view.applyScope('about');

  assert.deepEqual(harness.removed, [
    'appearance',
    'repository',
    'diagnostics-row',
    'diagnostics-help'
  ]);
  assert.deepEqual(harness.classToggles, [['settings-dialog-about', true]]);
});

test('full settings preserve every section', () => {
  const harness = createView(['appearance', 'repository', 'about']);

  harness.view.applyScope('full');

  assert.deepEqual(harness.removed, []);
  assert.deepEqual(harness.classToggles, [['settings-dialog-about', false]]);
});

test('settings navigation exposes exactly one active category and resets its scroll', () => {
  const classList = () => ({
    values: new Set(),
    toggle(name, enabled) {
      if (enabled) this.values.add(name);
      else this.values.delete(name);
    },
    contains(name) { return this.values.has(name); }
  });
  const section = name => ({
    dataset: { settingsSection: name },
    classList: classList(),
    attributes: {},
    toggleAttribute(name, enabled) { this.attributes[name] = enabled; },
    setAttribute(name, value) { this.attributes[name] = value; }
  });
  const navigation = name => ({
    dataset: { settingsNav: name },
    classList: classList(),
    attributes: {},
    toggleAttribute(name, enabled) { this.attributes[name] = enabled; }
  });
  const sections = [section('appearance'), section('remotes'), section('about')];
  const buttons = [navigation('appearance'), navigation('remotes'), navigation('about')];
  const scrollPositions = [];
  const view = Object.create(SettingsView.prototype);
  view.dialog = {
    querySelectorAll(selector) {
      return selector === '[data-settings-section]' ? sections : buttons;
    },
    querySelector(selector) {
      assert.equal(selector, '.settings-scroll');
      return { scrollTo: value => scrollPositions.push(value) };
    }
  };

  view.selectSection('remotes');

  assert.equal(view.activeSection, 'remotes');
  assert.equal(sections[1].classList.contains('is-active'), true);
  assert.equal(sections[0].attributes.hidden, true);
  assert.equal(sections[1].attributes.hidden, false);
  assert.equal(buttons[1].classList.contains('is-active'), true);
  assert.equal(buttons[1].attributes['aria-current'], true);
  assert.deepEqual(scrollPositions, [{ top: 0 }]);
});
