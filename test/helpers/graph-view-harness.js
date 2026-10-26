// Minimal DOM harness for GraphView: enough element behavior to run the real
// constructor, paging, filtering, author options and row virtualization in Node.

function createClassList(element) {
  const read = () => String(element.className || '').split(/\s+/).filter(Boolean);
  const write = values => { element.className = values.join(' '); };
  return {
    contains: value => read().includes(value),
    add: (...values) => write([...new Set([...read(), ...values])]),
    remove: (...values) => write(read().filter(value => !values.includes(value))),
    toggle(value, force) {
      const present = read().includes(value);
      const next = force === undefined ? !present : Boolean(force);
      if (next && !present) this.add(value);
      if (!next && present) this.remove(value);
      return next;
    }
  };
}

function createElement(tagName = 'div') {
  const listeners = new Map();
  const attributes = new Map();
  let selectValue = '';
  const element = {
    tagName: String(tagName).toUpperCase(),
    children: [],
    dataset: {},
    className: '',
    textContent: '',
    title: '',
    innerHTML: '',
    parentNode: null,
    scrollTop: 0,
    clientHeight: 0,
    style: {
      setProperty(name, value) { this[name] = value; },
      removeProperty(name) { delete this[name]; },
      getPropertyValue(name) { return this[name] || ''; }
    },
    append(...nodes) { nodes.forEach(node => element.appendChild(node)); },
    appendChild(node) {
      if (node && node.isFragment) {
        const moved = node.children;
        node.children = [];
        moved.forEach(child => {
          if (child && typeof child === 'object') child.parentNode = null;
          element.appendChild(child);
        });
        return node;
      }
      if (node && node.parentNode && node.parentNode !== element) node.parentNode.removeChild(node);
      if (node && node.parentNode === element) element.children.splice(element.children.indexOf(node), 1);
      element.children.push(node);
      if (node && typeof node === 'object') node.parentNode = element;
      return node;
    },
    removeChild(node) {
      const index = element.children.indexOf(node);
      if (index >= 0) element.children.splice(index, 1);
      if (node && typeof node === 'object') node.parentNode = null;
      return node;
    },
    replaceChildren(...nodes) {
      element.children.forEach(child => { if (child && typeof child === 'object') child.parentNode = null; });
      element.children = [];
      nodes.forEach(node => element.appendChild(node));
    },
    contains(node) {
      if (node === element) return true;
      return element.children.some(child => child === node || (child?.contains && child.contains(node)));
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    removeAttribute(name) { attributes.delete(name); },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener({ target: element, ...event });
    },
    listenerCount(type) { return listeners.get(type)?.size || 0; },
    querySelectorAll(selector) {
      if (selector === '.graph-row') {
        return element.children.filter(child => child?.classList?.contains('graph-row'));
      }
      return [];
    },
    querySelector() { return null; },
    closest() { return null; },
    focus() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; }
  };
  element.classList = createClassList(element);
  if (element.tagName === 'SELECT') {
    Object.defineProperty(element, 'value', {
      get: () => selectValue,
      set: value => {
        const match = element.children.find(option => option.value === String(value));
        selectValue = match ? match.value : '';
      }
    });
  } else {
    element.value = '';
  }
  return element;
}

function installGraphViewDom({ bridge, language = 'en', storage = {} } = {}) {
  const saved = {};
  const names = [
    'window', 'document', 'localStorage', 't', 'i18next', 'LocalizedDateFormatter',
    'requestAnimationFrame', 'cancelAnimationFrame'
  ];
  names.forEach(name => { saved[name] = Object.getOwnPropertyDescriptor(global, name); });

  const controls = {
    'history-filter-query': createElement('input'),
    'history-filter-author': createElement('select'),
    'history-filter-ref': createElement('select'),
    'history-sort': createElement('select'),
    'history-filter-clear': createElement('button')
  };
  const frames = [];
  const documentListeners = new Map();
  const stored = new Map(Object.entries(storage));

  global.window = {
    gitTree: bridge,
    GraphLayout: require('../../src/renderer/components/graph-layout.mts')
  };
  global.document = {
    createElement: tag => createElement(tag),
    createElementNS: (_namespace, tag) => createElement(tag),
    createTextNode: text => ({ textContent: String(text) }),
    createDocumentFragment: () => {
      const fragment = createElement('fragment');
      fragment.isFragment = true;
      return fragment;
    },
    getElementById: id => controls[id] || null,
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { documentListeners.get(type)?.delete(listener); },
    documentElement: createElement('html')
  };
  global.localStorage = {
    getItem: key => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: key => stored.delete(key)
  };
  global.t = key => key;
  const i18nListeners = new Map();
  global.i18next = {
    language,
    on(event, listener) {
      if (!i18nListeners.has(event)) i18nListeners.set(event, new Set());
      i18nListeners.get(event).add(listener);
    },
    off(event, listener) { i18nListeners.get(event)?.delete(listener); },
    emit(event, ...args) { for (const listener of i18nListeners.get(event) || []) listener(...args); }
  };
  global.LocalizedDateFormatter = { create: () => value => `date:${value}` };
  global.requestAnimationFrame = callback => {
    frames.push(callback);
    return frames.length;
  };
  global.cancelAnimationFrame = id => { if (frames[id - 1]) frames[id - 1] = null; };

  const restore = () => {
    names.forEach(name => {
      if (saved[name]) Object.defineProperty(global, name, saved[name]);
      else delete global[name];
    });
  };
  const flushFrames = () => {
    while (frames.some(Boolean)) {
      const pending = frames.splice(0, frames.length);
      pending.forEach(callback => callback && callback(0));
    }
  };
  return { controls, storage: stored, restore, flushFrames };
}

function createGraphViewHarness(GraphView, { bridge, language, storage, clientHeight = 600 } = {}) {
  const dom = installGraphViewDom({ bridge, language, storage });
  const container = createElement('div');
  container.clientHeight = clientHeight;
  Object.defineProperty(container, 'scrollHeight', {
    get: () => Math.max(clientHeight, (Number.parseFloat(body.style.height) || 0) + 36)
  });
  const body = createElement('div');
  const emitted = [];
  const app = {
    components: {},
    syncInspectorWorkspace() {},
    emit: (...args) => emitted.push(args),
    isPrimaryModifier: event => Boolean(event?.ctrlKey || event?.metaKey)
  };
  const view = new GraphView(container, body, app);
  return { ...dom, view, container, body, app, emitted };
}

module.exports = { createElement, installGraphViewDom, createGraphViewHarness };
