// ============================================================
//  Mono — shared command registry (U1 foundation, powers U6's
//  command palette). Every mode registers its own commands here;
//  the palette just searches/renders/runs whatever's currently
//  registered. Commands are grouped and replaced by group on
//  re-registration so switching sheets/pages doesn't leak stale
//  entries (e.g. re-mounting a sheet replaces its 'Sheet' group).
// ============================================================
let _commands = [];

/**
 * @param {string} group - logical group name; re-registering the same
 *   group replaces its previous entries (avoids duplicates/staleness).
 * @param {Array<{id,label,icon?,kbd?,keywords?,run:Function}>} list
 */
export function registerCommands(group, list) {
  _commands = _commands.filter((c) => c.group !== group);
  for (const c of list) _commands.push({ group, ...c });
}
export function clearGroup(group) { _commands = _commands.filter((c) => c.group !== group); }
export function getCommands() { return _commands.slice(); }
export function runCommand(id) { const c = _commands.find((x) => x.id === id); if (c) c.run(); }

export default { registerCommands, clearGroup, getCommands, runCommand };
