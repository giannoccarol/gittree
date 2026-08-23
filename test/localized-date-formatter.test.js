const test = require('node:test');
const assert = require('node:assert/strict');
let LocalizedDateFormatter;
try {
  const mod = require('../src/renderer/localized-date-formatter.mts');
  LocalizedDateFormatter = mod.LocalizedDateFormatter || mod.default || mod;
} catch {
  LocalizedDateFormatter = require('../src/renderer/localized-date-formatter');
}

test('localized date formatter preserves the existing short date and time output', () => {
  const format = LocalizedDateFormatter.create();
  const value = '2026-08-02T14:35:00.000Z';

  for (const language of ['en', 'it']) {
    assert.equal(format(value, language), new Date(value).toLocaleString(language, {
      dateStyle: 'short',
      timeStyle: 'short'
    }));
  }
  assert.equal(format('', 'en'), '');
  assert.equal(format('not-a-date', 'en'), 'Invalid Date');
});

test('localized date formatter reuses one Intl formatter until the language changes', () => {
  const createdFor = [];
  class FakeDateTimeFormat {
    constructor(language) {
      createdFor.push(language);
      this.language = language;
    }

    format(date) {
      return `${this.language}:${date.toISOString()}`;
    }
  }
  const format = LocalizedDateFormatter.create({ DateTimeFormat: FakeDateTimeFormat });

  format('2026-01-01T00:00:00.000Z', 'en');
  format('2026-01-02T00:00:00.000Z', 'en');
  format('2026-01-03T00:00:00.000Z', 'it');

  assert.deepEqual(createdFor, ['en', 'it']);
});
