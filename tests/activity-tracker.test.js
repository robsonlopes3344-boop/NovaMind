const test = require('node:test');
const assert = require('node:assert/strict');
const { countLineChanges, compareWorkspaceSnapshots } = require('../src/activity-tracker');

test('counts added and removed lines using common lines', () => {
  assert.deepEqual(countLineChanges('one\ntwo\nthree', 'one\nchanged\nthree\nfour'), { added: 2, removed: 1 });
  assert.deepEqual(countLineChanges('', 'first\nsecond'), { added: 2, removed: 0 });
  assert.deepEqual(countLineChanges('first\nsecond', ''), { added: 0, removed: 2 });
});

test('compares created, modified and deleted source files', () => {
  const before = {
    root: 'C:/project', scanned: 3, truncated: false,
    files: new Map([
      ['src/app.js', { isCode: true, size: 20, mtimeMs: 1, content: 'const a = 1;\nconsole.log(a);' }],
      ['src/lib.js', { isCode: true, size: 10, mtimeMs: 1, content: 'one\ntwo\nthree' }],
      ['old.py', { isCode: true, size: 8, mtimeMs: 1, content: 'print(1)' }]
    ])
  };
  const after = {
    root: 'C:/project', scanned: 3, truncated: false,
    files: new Map([
      ['src/app.js', { isCode: true, size: 20, mtimeMs: 2, content: 'const a = 1;\nconsole.log(a);' }],
      ['src/lib.js', { isCode: true, size: 25, mtimeMs: 2, content: 'one\nchanged\nthree\nfour' }],
      ['new.ts', { isCode: true, size: 7, mtimeMs: 2, content: 'x\ny' }]
    ])
  };
  const diff = compareWorkspaceSnapshots(before, after);
  assert.equal(diff.filesAdded, 1);
  assert.equal(diff.filesModified, 1);
  assert.equal(diff.filesRemoved, 1);
  assert.equal(diff.filesChanged, 3);
  assert.equal(diff.codeFilesChanged, 3);
  assert.equal(diff.linesAdded, 4);
  assert.equal(diff.linesRemoved, 2);
  assert.equal(diff.lineCountsComplete, true);
  assert.deepEqual(diff.changedFiles.map(file => file.kind), ['modified', 'added', 'removed']);
});

test('does not count touch-only timestamp changes when file contents are available', () => {
  const item = { isCode: true, size: 5, mtimeMs: 1, content: 'same\ntext' };
  const later = { ...item, mtimeMs: 99 };
  const diff = compareWorkspaceSnapshots({ root: '.', files: new Map([['a.js', item]]) }, { root: '.', files: new Map([['a.js', later]]), scanned: 1 });
  assert.equal(diff.filesChanged, 0);
  assert.equal(diff.linesAdded, 0);
  assert.equal(diff.linesRemoved, 0);
});

test('marks line counts partial when a changed source file is too large to diff', () => {
  const diff = compareWorkspaceSnapshots(
    { root: '.', files: new Map([['large.ts', { isCode: true, size: 500000, mtimeMs: 1, content: null }]]) },
    { root: '.', files: new Map([['large.ts', { isCode: true, size: 500100, mtimeMs: 2, content: null }]]), scanned: 1 }
  );
  assert.equal(diff.filesModified, 1);
  assert.equal(diff.codeFilesChanged, 1);
  assert.equal(diff.lineCountsComplete, false);
});