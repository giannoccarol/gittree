const test = require('node:test');
const assert = require('node:assert/strict');
let HtmlEncoder;
try {
  const mod = require('../src/renderer/html-encoder.mts');
  HtmlEncoder = mod.HtmlEncoder || mod.default || mod;
} catch {
  HtmlEncoder = require('../src/renderer/html-encoder');
}

test('HTML encoder preserves the legacy renderer escaping contract', () => {
  assert.equal(HtmlEncoder.encode(null), '');
  assert.equal(HtmlEncoder.encode(undefined), '');
  assert.equal(HtmlEncoder.encode('plain text'), 'plain text');
  assert.equal(
    HtmlEncoder.encode('<img src="x" onerror=\'steal()\'> & done'),
    '&lt;img src=&quot;x&quot; onerror=&#39;steal()&#39;&gt; &amp; done'
  );
  assert.equal(HtmlEncoder.encode(42), '42');
});

test('HTML encoder is safe for both element content and quoted attributes', () => {
  const encoded = HtmlEncoder.encode('" autofocus onfocus="attack()');
  assert.equal(encoded, '&quot; autofocus onfocus=&quot;attack()');
  assert.doesNotMatch(encoded, /["<>]/);
});
