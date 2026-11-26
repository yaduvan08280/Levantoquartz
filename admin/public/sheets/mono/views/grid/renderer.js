// ============================================================
//  Mono — Grid view renderer  (P9)
//
//  Satisfies the renderer contract:
//    render(host, mount) → void
//    commandBarConfig(spec) → null  (grid uses the default toolbar)
//
//  The grid renderer delegates to MonoGrid's existing gridHTML()
//  and bind() methods via host._grid — a mechanical extraction
//  that preserves all existing behaviour without a rewrite.
//
//  Other renderers (Kanban, Calendar, Gallery, Form) do NOT use
//  host._grid — they are fully standalone.
// ============================================================
import { registerViewKind } from '../registry.js';

/**
 * Render the spreadsheet table into `mount` and wire all events.
 * Called by MonoGrid.render() in place of the old inline gridHTML()+bind().
 * @param {host} host
 * @param {HTMLElement} mount — the #msScroll div
 */
export function render(host, mount) {
  const grid = host._grid;
  if (!grid) return;   // should never happen for the grid renderer
  const sh = grid.sheet();
  // Build the table HTML and the floating editor input
  const tableHTML = grid.gridHTML(sh);
  // Textarea (not <input>) so Alt+Enter can insert a real newline inside a
  // cell, matching Excel's in-cell line breaks. CSS keeps it looking like
  // the old single-line editor until a newline actually exists.
  mount.innerHTML = tableHTML
    + `<textarea class="ms-edit" id="msEdit" rows="1" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off" data-lpignore="true" data-form-type="other" name="ms-edit-${Math.random().toString(36).slice(2, 8)}" style="display:none"></textarea>`;
  // Update MonoGrid's element refs (previously set in render() directly)
  grid.tableEl = mount.querySelector('#msTable');
  grid.editor  = mount.querySelector('#msEdit');
  // Wire all grid events
  grid.bind();
}

/**
 * Grid view uses the default command bar — no override needed.
 */
export function commandBarConfig(_spec) {
  return null;
}

// Self-register into the view kind registry.
// This module is imported by grid.js, so it runs at app boot.
registerViewKind({
  kind:             'grid',
  label:            'Grid',
  icon:             'grid',
  render,
  commandBarConfig,
});
