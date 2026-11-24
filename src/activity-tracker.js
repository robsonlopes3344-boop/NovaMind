function countLineChanges(oldText, newText) {
  const before = oldText.length ? oldText.split(/\r?\n/) : [];
  const after = newText.length ? newText.split(/\r?\n/) : [];
  if (before.length * after.length > 1_500_000) return null;
  let previous = new Uint32Array(after.length + 1);
  for (let i = 1; i <= before.length; i++) {
    const current = new Uint32Array(after.length + 1);
    for (let j = 1; j <= after.length; j++) {
      current[j] = before[i - 1] === after[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  const common = previous[after.length];
  return { added: after.length - common, removed: before.length - common };
}

function compareWorkspaceSnapshots(before, after) {
  let filesAdded = 0;
  let filesModified = 0;
  let filesRemoved = 0;
  let codeFilesChanged = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let lineCountsComplete = true;
  const changedFiles = [];

  const addRecord = (relativePath, kind, oldItem, newItem) => {
    const item = newItem || oldItem;
    const isCode = Boolean(item?.isCode);
    let added = 0;
    let removed = 0;
    if (isCode) {
      codeFilesChanged++;
      const oldContent = oldItem?.content;
      const newContent = newItem?.content;
      if (oldContent !== null && oldContent !== undefined && newContent !== null && newContent !== undefined) {
        const delta = countLineChanges(oldContent, newContent);
        if (delta) {
          added = delta.added;
          removed = delta.removed;
          linesAdded += added;
          linesRemoved += removed;
        } else {
          lineCountsComplete = false;
        }
      } else if (kind === 'added' && newContent !== null && newContent !== undefined) {
        added = newContent.length ? newContent.split(/\r?\n/).length : 0;
        linesAdded += added;
      } else if (kind === 'removed' && oldContent !== null && oldContent !== undefined) {
        removed = oldContent.length ? oldContent.split(/\r?\n/).length : 0;
        linesRemoved += removed;
      } else {
        lineCountsComplete = false;
      }
    }
    if (changedFiles.length < 100) changedFiles.push({ path: relativePath, kind, isCode, added, removed });
  };

  for (const [relative, current] of after.files) {
    const old = before.files.get(relative);
    if (!old) {
      filesAdded++;
      addRecord(relative, 'added', null, current);
      continue;
    }
    const comparableText = old.content !== null && old.content !== undefined &&
      current.content !== null && current.content !== undefined;
    const changed = comparableText
      ? old.content !== current.content
      : old.size !== current.size || old.mtimeMs !== current.mtimeMs;
    if (changed) {
      filesModified++;
      addRecord(relative, 'modified', old, current);
    }
  }

  for (const [relative, old] of before.files) {
    if (!after.files.has(relative)) {
      filesRemoved++;
      addRecord(relative, 'removed', old, null);
    }
  }

  return {
    tracked: true,
    root: before.root,
    scannedFiles: after.scanned,
    truncated: Boolean(before.truncated || after.truncated),
    filesAdded,
    filesModified,
    filesRemoved,
    filesChanged: filesAdded + filesModified + filesRemoved,
    codeFilesChanged,
    linesAdded,
    linesRemoved,
    lineCountsComplete,
    changedFiles
  };
}

module.exports = { countLineChanges, compareWorkspaceSnapshots };