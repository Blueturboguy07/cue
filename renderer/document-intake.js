/* Document-intake core — the pure state machine behind the import UI.
 *
 * Owns everything about the file lists that does not touch the DOM: sanitizing
 * persisted lists, appending imported files, merging appended text into a field
 * value, removing one file's text, clearing a field, and building status copy.
 *
 * The renderer (renderer.js) keeps the session state and DOM adapters; this
 * module is DOM-free so the whole intake behavior is unit-testable. The textarea
 * stays the single source of truth; the lists are metadata over it.
 */
(function () {
  // Labels used in user-facing status messages ("Resume import failed: …").
  const FIELD_LABELS = { projectNotes: 'Document', resume: 'Resume', jd: 'Job description' };

  // Normalize a persisted list (settings.resumeFiles & co.) into [{ fileName, text }].
  // Junk entries are dropped rather than crashing the panel.
  function sanitizeList(list) {
    return Array.isArray(list)
      ? list.filter((x) => x && typeof x === 'object').map((x) => ({ fileName: x.fileName, text: x.text }))
      : [];
  }

  // Append imported files to a session list. Returns the new list plus the joined
  // text those files contributed ('' when none had extractable text).
  function appendFiles(list, files) {
    const clean = sanitizeList(files);
    const addedText = clean.map((x) => x.text).filter(Boolean).join('\n\n');
    return { list: (list || []).concat(clean), addedText };
  }

  // Merge appended text into the field value without clobbering what is already
  // there (pasted or previously saved content is preserved).
  function mergeIntoValue(current, added) {
    if (!added) return current == null ? '' : current;
    const trimmed = String(current == null ? '' : current).trim();
    return trimmed ? trimmed + '\n\n' + added : added;
  }

  // Remove fileText from a field value. File text is appended verbatim on import,
  // so the last occurrence is the file's own copy; if the user edited it away, the
  // value is left untouched (the row is still removed — the content is already gone).
  function removeFileText(value, fileText) {
    if (!fileText) return value == null ? '' : value;
    const idx = String(value).lastIndexOf(fileText);
    if (idx === -1) return value;
    const before = String(value).slice(0, idx).replace(/[ \t]*\n+[ \t]*$/, '');
    const after = String(value).slice(idx + fileText.length).replace(/^[ \t]*\n+[ \t]*/, '');
    return (before + '\n\n' + after).replace(/\n{3,}/g, '\n\n').trim();
  }

  // Remove one file row: returns { list, value } — the row always goes, and the
  // field value has that file's text surgically removed when it is still present.
  function deleteFile(list, idx, value) {
    const file = (list || [])[idx];
    if (!file) return { list: list || [], value };
    const next = (list || []).slice();
    next.splice(idx, 1);
    return { list: next, value: removeFileText(value, file.text) };
  }

  // Clear the whole field — every row and all its text.
  function clearField() {
    return { list: [], value: '' };
  }

  // Whether the field actually has content (drives the ✖ clear button visibility,
  // including text restored from settings that was never in a session list).
  function hasContent(value) {
    return !!(value && String(value).trim().length);
  }

  // Status message for an import result; null when nothing happened to report.
  // files/errors come from the main-process pick result ({ fileName, text } /
  // { fileName, error }).
  function importStatus(type, files, errors) {
    const label = FIELD_LABELS[type] || 'Document';
    const f = files || [];
    const e = errors || [];
    if (e.length) {
      const first = e[0];
      return label + ' import: ' + f.length + ' of ' + (f.length + e.length) + ' succeeded; ' + first.fileName + ' failed — ' + first.error;
    }
    if (f.length) {
      const name = f.length > 1 ? f.length + ' files' : f[0].fileName;
      return 'Imported ' + name + ' — press Done to save.';
    }
    return null;
  }

  window.CueDocumentIntake = {
    FIELD_LABELS,
    sanitizeList,
    appendFiles,
    mergeIntoValue,
    removeFileText,
    deleteFile,
    clearField,
    hasContent,
    importStatus
  };
})();
