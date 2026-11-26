import { absoluteDir, list, matchesFilter, shortDir, statusOf } from './shared.mjs';

const needsAttention = new Set(['clarify', 'handoff', 'input-required']);
const inProgress = new Set(['dispatching', 'queued', 'running']);
const identifier = v => typeof v === 'string' && !!v && v === v.trim() && !/[\u0000-\u001f\u007f]/u.test(v);

// Titles are display text only. Bound their size without splitting a surrogate pair;
// retain the exact path / ID in detail, even when two abbreviated titles are identical.
function caption(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\s\u0000-\u001f\u007f]+/gu, ' ').trim();
  let result = '', count = 0;
  for (const char of text) {
    if (count++ === 64) return result + '…';
    result += char;
  }
  return result;
}

function demandCaption(task) {
  const original = caption(task.text);
  if (original) return original;
  for (const i of list(task.items)) {
    if (!i?.parentItemId) {
      const text = caption(i?.text);
      if (text) return text;
    }
  }
  return '';
}

function creationTime(value) {
  let n = value;
  if (typeof value === 'string') {
    const s = value.trim();
    n = /^-?\d+$/u.test(s) ? Number(s) : Date.parse(s);
  }
  return Number.isFinite(n) ? n : -Infinity;
}

// The directory in an unresolved clarify item may be a fresh reviewRoute suggestion.
// Do not elevate that, candidateDirs, expectedSessionId, titles or defaults to identity.
// Use *all* items, not the ones visible under a filter, and never split an old graph.
function destination(task) {
  const paths = new Set(), ids = new Set();
  for (const i of list(task.items)) {
    const undecided = i?.status === 'clarify' || i?.decision === 'clarify';
    paths.add(!undecided && absoluteDir(i?.project) ? i.project : null);
    ids.add(!undecided && identifier(i?.sessionId) ? i.sessionId : null);
  }
  const path = paths.values().next().value ?? null;
  const distinctIds = ids.size - Number(ids.has(null));
  if (paths.size > 1 || (!path && distinctIds > 1)) {
    return {path: null, sid: null, kind: 'multi-target'};
  }
  if (path && ids.size > 1) return {path, sid: null, kind: ids.has(null) ? 'mixed-session' : 'multi-session'};
  const sid = path ? ids.values().next().value ?? null : null;
  return {path, sid, kind: sid ? 'bound' : 'unbound'};
}

function directories(settings) {
  const names = new Map();
  for (const p of list(settings?.projects)) {
    if (absoluteDir(p?.path) && !names.has(p.path)) names.set(p.path, caption(p.name) || caption(shortDir(p.path)));
  }
  if (absoluteDir(settings?.generalDir) && !names.has(settings.generalDir)) names.set(settings.generalDir, '通用目录');
  return names;
}

function liveRoster(state) {
  const rows = new Map();
  if (state?.connected !== undefined && state.connected !== true) return rows;
  for (const row of list(state?.sessions)) {
    // An ambiguous native ID must not pick a title according to roster array order.
    if (identifier(row?.id)) rows.set(row.id, rows.has(row.id) ? null : row);
  }
  return rows;
}

function liveTitle(row, path, sid, names) {
  if (!names.has(path) || row?.cwd !== path || typeof row.title !== 'string') return '';
  const title = row.title.trim();
  // The adapter itself uses the opaque ID when there is no native title.
  return title === sid ? '' : caption(title);
}

function makeProject({projectKey: key, path, kind}, names) {
  const history = kind === 'multi-target';
  const label = path ? names.get(path) || caption(shortDir(path)) || '历史目录' : history ? '历史多目标' : '待归属';
  const detail = path || (history ? '旧需求涉及多个项目，或各分项没有统一的目标。' : '尚未确定项目的本机需求。');
  return {key, path, label, detail, sessions: [], count: 0, sessionCount: 0, attention: 0, active: 0};
}

function makeSession({sessionKey: key, sid, kind}, label) {
  let detail = sid;
  if (sid) label ||= '未命名会话';
  else if (kind === 'mixed-session') { label = '会话未统一'; detail = '项目已确定；这些旧需求里有分项尚未绑定会话。'; }
  else if (kind === 'multi-session') { label = '历史多会话'; detail = '同一项目中的旧需求涉及多个会话，按原需求保留。'; }
  else if (kind === 'multi-target') { label = '多目标需求'; detail = '这些旧需求没有单一会话，请在原需求内核对分项。'; }
  else { label = '未绑定会话'; detail = '尚未确定单一会话；候选或推荐不代表已绑定。'; }
  return {key, sid, label, detail, tasks: [], count: 0, attention: 0, active: 0};
}

/** Project only this local snapshot; this model neither reads a session nor authorizes opening it. */
export function groupLedger(state, filter = '') {
  const names = directories(state?.settings), roster = liveRoster(state);
  const rows = [];
  for (const task of list(state?.tasks)) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
    const target = destination(task);
    const projectKey = target.path ? 'dir:' + target.path : target.kind === 'multi-target' ? 'multi-target' : 'unassigned';
    const sessionKey = JSON.stringify([projectKey, target.kind, target.sid]);
    rows.push({task, ...target, projectKey, sessionKey, time: creationTime(task.createdAt), id: typeof task.id === 'string' ? task.id : ''});
  }
  rows.sort((a, b) => b.time - a.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Name from the earliest readable local demand, even if it does not pass today's
  // filter. Neither a later follow-up nor another task's status should rename a group.
  const labels = new Map();
  for (let n = rows.length - 1; n >= 0; n--) {
    const {task, path, sid, sessionKey} = rows[n];
    if (!sid || labels.has(sessionKey)) continue;
    const label = liveTitle(roster.get(sid), path, sid, names) || demandCaption(task);
    if (label) labels.set(sessionKey, label);
  }

  // Insertion order now gives newest *matching demand* first at every level.
  const projects = new Map(), sessions = new Map();
  for (const row of rows) {
    if (!matchesFilter(row.task, filter)) continue;
    let p = projects.get(row.projectKey), s = sessions.get(row.sessionKey);
    if (!p) { p = makeProject(row, names); projects.set(p.key, p); }
    if (!s) {
      s = makeSession(row, labels.get(row.sessionKey)); sessions.set(s.key, s); p.sessions.push(s);
      if (s.sid) p.sessionCount++;
    }
    s.tasks.push(row.task); s.count++; p.count++;
    let attention = false, active = false;
    for (const i of list(row.task.items)) {
      const status = statusOf(i);
      attention ||= needsAttention.has(status); active ||= inProgress.has(status);
    }
    if (attention) { s.attention++; p.attention++; }
    if (active) { s.active++; p.active++; }
  }
  return [...projects.values()];
}
