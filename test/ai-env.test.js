const test = require('node:test');
const assert = require('node:assert/strict');

const { environmentForAi } = require('../src/main/ai/ai-env.mts');

test('exports nothing without an API key', () => {
  assert.deepEqual(environmentForAi({ provider: 'openai', baseUrl: '', apiKey: '' }), {});
});

test('maps anthropic keys to ANTHROPIC_API_KEY', () => {
  assert.deepEqual(environmentForAi({
    provider: 'anthropic',
    baseUrl: '',
    apiKey: 'sk-ant-123'
  }), { ANTHROPIC_API_KEY: 'sk-ant-123' });
});

test('maps deepseek endpoints to DEEPSEEK_API_KEY', () => {
  assert.deepEqual(environmentForAi({
    provider: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-deep'
  }), { DEEPSEEK_API_KEY: 'sk-deep' });
});

test('maps other openai-compatible endpoints to OPENAI_API_KEY and base URL', () => {
  assert.deepEqual(environmentForAi({
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-openai'
  }), {
    OPENAI_API_KEY: 'sk-openai',
    OPENAI_BASE_URL: 'https://api.openai.com/v1'
  });
});

test('omits OPENAI_BASE_URL when no base URL is configured', () => {
  assert.deepEqual(environmentForAi({
    provider: 'openai',
    baseUrl: '',
    apiKey: 'sk-local'
  }), { OPENAI_API_KEY: 'sk-local' });
});
