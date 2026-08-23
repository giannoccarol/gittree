const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

let ChangesFileList;
try {
  const mod = require(path.join(
    __dirname,
    '..',
    'src',
    'renderer',
    'components',
    'changes-file-list.mts'
  ));
  ChangesFileList = mod.ChangesFileList || mod.default || mod;
} catch {
  ChangesFileList = require(path.join(
    __dirname,
    '..',
    'src',
    'renderer',
    'components',
    'changes-file-list.js'
  ));
}

function createElement(tag = 'div') {
  return {
    tag,
    className: '',
    textContent: '',
    style: {},
    children: [],
    listeners: {},
    appendChild(child) {
      if (child.tag === '#fragment') this.children.push(...child.children);
      else this.children.push(child);
      return child;
    },
    replaceChildren(...nodes) {
      this.children = [];
      for (const node of nodes) {
        if (node.tag === '#fragment') this.children.push(...node.children);
        else this.children.push(node);
      }
    },
    addEventListener(name, listener) {
      this.listeners[name] = this.listeners[name] || [];
      this.listeners[name].push(listener);
    },
    removeEventListener(name, listener) {
      if (!this.listeners[name]) return;
      this.listeners[name] = this.listeners[name].filter(item => item !== listener);
    },
    emit(name, event = {}) {
      (this.listeners[name] || []).forEach(listener => listener(event));
    }
  };
}

function createDocument() {
  const elements = [];
  return {
    elements,
    createElement(tag) {
      const element = createElement(tag);
      elements.push(element);
      return element;
    },
    createDocumentFragment() {
      return createElement('#fragment');
    }
  };
}

function createHarness({ files = 10, rowHeight = 38, overscan = 4 } = {}) {
  const documentRef = createDocument();
  const container = createElement();
  container.clientHeight = 200;
  container.scrollTop = 0;
  let frameCallback = null;
  const observers = [];
  const list = new ChangesFileList(container, {
    rowHeight,
    overscan,
    document: documentRef,
    requestFrame: callback => {
      frameCallback = callback;
      return 1;
    },
    observerFactory: callback => {
      const observer = {
        callback,
        observed: [],
        observe(target) { this.observed.push(target); },
        disconnect() { this.observed = []; }
      };
      observers.push(observer);
      return observer;
    }
  });
  const items = Array.from({ length: files }, (_, index) => ({
    path: `src/file-${index}.js`
  }));
  const renderRow = (item, index) => {
    const row = createElement();
    row.className = 'changes-file-row';
    row.textContent = item.path;
    row.dataset = { index: String(index) };
    return row;
  };
  return { list, container, documentRef, items, renderRow, observers, flushFrame: () => {
    if (frameCallback) {
      const callback = frameCallback;
      frameCallback = null;
      callback();
    }
  } };
}

test('renders only the visible window inside a correctly sized spacer', () => {
  const harness = createHarness({ files: 100 });
  harness.list.mount();
  harness.list.update(harness.items, harness.renderRow, 'empty');

  const spacer = harness.container.children[0];
  assert.equal(spacer.className, 'changes-file-spacer');
  assert.equal(spacer.style.height, '3800px');
  const rendered = harness.container.children[0].children;
  assert.ok(rendered.length < 100);
  assert.ok(rendered.length > 0);
  assert.equal(rendered[0].style.top, '0px');
  assert.equal(rendered[1].style.top, '38px');
  assert.equal(rendered[0].textContent, 'src/file-0.js');
});

test('empty update renders the placeholder text and removes the spacer', () => {
  const harness = createHarness({ files: 0 });
  harness.list.mount();
  harness.list.update([], harness.renderRow, 'nothing here');

  assert.equal(harness.container.children.length, 1);
  assert.equal(harness.container.children[0].className, 'changes-empty');
  assert.equal(harness.container.children[0].textContent, 'nothing here');
});

test('scrolling repaints the window without duplicating rows', () => {
  const harness = createHarness({ files: 100 });
  harness.list.mount();
  harness.list.update(harness.items, harness.renderRow, 'empty');
  const spacer = harness.container.children[0];
  const firstCount = spacer.children.length;

  harness.container.scrollTop = 760;
  harness.container.emit('scroll');
  harness.flushFrame();

  assert.equal(spacer.children.length, firstCount);
  assert.equal(spacer.children[0].style.top, `${(760 / 38 - 4) * 38}px`);
  assert.equal(spacer.children[0].textContent, 'src/file-16.js');
});

test('update preserves the scroll position and replaces stale rows', () => {
  const harness = createHarness({ files: 100 });
  harness.list.mount();
  harness.list.update(harness.items, harness.renderRow, 'empty');
  harness.container.scrollTop = 228;

  harness.list.update(harness.items, harness.renderRow, 'empty');

  assert.equal(harness.container.scrollTop, 228);
  assert.equal(harness.container.children.length, 1);
  assert.equal(harness.container.children[0].children.length > 0, true);
});

test('resize repaints the visible window', () => {
  const harness = createHarness({ files: 100 });
  harness.list.mount();
  harness.list.update(harness.items, harness.renderRow, 'empty');
  const spacer = harness.container.children[0];
  const firstCount = spacer.children.length;

  harness.container.clientHeight = 400;
  harness.observers[0].callback();
  harness.flushFrame();

  assert.ok(spacer.children.length > firstCount);
  assert.ok(spacer.children.length < 100);
});

test('destroy detaches the scroll listener and disconnects the observer', () => {
  const harness = createHarness({ files: 10 });
  harness.list.mount();
  assert.equal(harness.container.listeners.scroll.length, 1);
  assert.equal(harness.observers[0].observed.length, 1);

  harness.list.destroy();

  assert.equal(harness.container.listeners.scroll.length, 0);
  assert.equal(harness.observers[0].observed.length, 0);
});
