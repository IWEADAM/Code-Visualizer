import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const rulesContent = fs.readFileSync('firestore.rules', 'utf-8');

test('Dirty Dozen security rules invariants are enforced in firestore.rules', () => {
  // 1. Default deny catch-all
  assert.match(rulesContent, /match \/\{document=\*\*\} \{\s*allow read, write: if false;\s*\}/);

  // 2. Verified email check on writes
  assert.match(rulesContent, /request\.auth\.token\.email_verified == true/);

  // 3. Path variable hardening
  assert.match(rulesContent, /function isValidId\(id\)/);
  assert.match(rulesContent, /isValidId\(repoId\)/);

  // 4. Strict key validation (hasAll + hasOnly)
  assert.match(rulesContent, /data\.keys\(\)\.hasAll\(/);
  assert.match(rulesContent, /data\.keys\(\)\.hasOnly\(/);

  // 5. Secure list query enforcement on resource.data
  assert.match(rulesContent, /allow list: if isSignedIn\(\) && existing\(\)\.ownerId == request\.auth\.uid;/);

  // 6. Temporal integrity & immutability
  assert.match(rulesContent, /incoming\(\)\.createdAt == request\.time/);
  assert.match(rulesContent, /incoming\(\)\.updatedAt == request\.time/);
  assert.match(rulesContent, /incoming\(\)\.ownerId == existing\(\)\.ownerId/);
  assert.match(rulesContent, /incoming\(\)\.createdAt == existing\(\)\.createdAt/);
});
