'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeApiBaseUrl } = require('../scripts/application-smoke-test');
const { hasRecommendedRetention } = require('../scripts/audit-b2-retention');
test('API base URL requires HTTPS and rejects embedded credentials', () => {
  assert.equal(normalizeApiBaseUrl('https://api.example.com/'), 'https://api.example.com');
  assert.throws(() => normalizeApiBaseUrl('http://api.example.com'), /HTTPS/);
  assert.throws(() => normalizeApiBaseUrl('https://user:pass@api.example.com'), /HTTPS/);
});
test('B2 retention audit accepts only the intended 90-day database prefix rule', () => {
  assert.equal(hasRecommendedRetention([{ fileNamePrefix: 'database/', daysFromUploadingToHiding: 90, daysFromHidingToDeleting: 1 }]), true);
  assert.equal(hasRecommendedRetention([{ fileNamePrefix: 'database/', daysFromUploadingToHiding: 30, daysFromHidingToDeleting: 1 }]), false);
  assert.equal(hasRecommendedRetention([]), false);
});
