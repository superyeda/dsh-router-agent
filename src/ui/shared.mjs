// The preview and the sender use the same model policy. IDs are data, never markup or URLs.
import { modelMode, resolveTiers } from '../core/models.mjs';
export const TIERS = [
  ['fast', '快速', '短问答、整理，以及意图分类'],
  ['standard', '标准', '常规实施与跨文件工作'],
  ['deep', '深入', '复杂分析、设计与审查'],
];
export const SESSION_MODES = new Map([['standard','标准模式'],['ptc','PTC 模式'],['inherit','跟随 DSH 默认']]);
export const STATUS = new Map([
  ['new', ['待路由', 'neutral']], ['clarify', ['待选择', 'amber']],
  ['waiting', ['等待依赖', 'neutral']], ['handoff', ['待确认交接', 'amber']],
  ['dispatching', ['派发中', 'blue']], ['queued', ['已排队', 'blue']],
  ['running', ['运行中', 'blue']], ['input-required', ['需输入', 'amber']],
  ['done', ['已完成', 'green']], ['failed', ['失败', 'red']], ['unknown', ['状态未知', 'neutral']],
]);
export const list = v => Array.isArray(v) ? v : [];
export const str = v => v == null ? '' : String(v);
export const statusOf = item => STATUS.has(item?.status) ? item.status : 'unknown';
export const matchesFilter = (task, filter) => !filter || list(task.items).some(i => statusOf(i) === filter);
// A mixed historical record never looks complete just because one part finished.
const statusPriority = ['input-required','handoff','clarify','running','dispatching','queued','unknown','failed','waiting','new','done'];
export function recordStatus(task) {
  const states = new Set(list(task.items).map(statusOf));
  return statusPriority.find(s=>states.has(s)) || 'unknown';
}
export function recordCaption(task) {
  const value = str(task.text || list(task.items)[0]?.text).replace(/\s+/gu, ' ').trim();
  const chars = Array.from(value);
  return chars.length>100 ? chars.slice(0,100).join('')+'…' : value || '未命名任务';
}
export { candidateAt } from '../core/record-policy.mjs';
export const pairKey = (a, b) => JSON.stringify([a, b]);
export const shortDir = p => p.split(/[\\/]/).filter(Boolean).at(-1) || p;
export function absoluteDir(p) {
  return typeof p === 'string' && p.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(p) &&
    (/^\//.test(p) || /^[a-z]:[\\/]/i.test(p)) && !p.split(/[\\/]/).some(part => part === '.' || part === '..');
}
function pathKey(p) {
  const q = p.trim().replace(/[\\/]+$/, '') || '/';
  return /^[A-Za-z]:|^\\\\/.test(q) ? q.replace(/\\/g, '/').toLowerCase() : q;
}
export function catalogEntries(catalog) {
  const entries = new Map();
  for (const m of list(catalog)) {
    if (!m?.provider || !m.model) continue;
    const key = pairKey(m.provider, m.model);
    const row = entries.get(key) || {key, provider:m.provider, model:m.model, efforts:[]};
    row.efforts = [...new Set([...row.efforts, ...list(m.efforts).filter(e => typeof e === 'string' && e)])];
    entries.set(key, row);
  }
  return [...entries.values()];
}
export function directoryOptions(rows, generalDir = '') {
  const dirs = new Map();
  for (const row of list(rows)) {
    const p = str(row?.path).trim();
    if (absoluteDir(p) && !dirs.has(p)) dirs.set(p, row.name ? row.name + ' · ' + p : p);
  }
  if (absoluteDir(generalDir) && !dirs.has(generalDir)) dirs.set(generalDir, '通用目录 · ' + generalDir);
  return [...dirs].map(([value, label]) => ({value, label}));
}
export function copySettings(v = {}) {
  return {modelMode:v?.modelMode==null?modelMode(v || {}):str(v.modelMode), autoProvider:str(v?.autoProvider),
    sessionMode:v?.sessionMode==null ? 'standard' : str(v.sessionMode),
    defaultProject:str(v?.defaultProject), generalDir:str(v?.generalDir), projects:list(v?.projects).map(p => ({path:str(p?.path), name:str(p?.name)})),
    tiers:Object.fromEntries(TIERS.map(([k]) => { const t = v?.tiers?.[k]; return [k, {provider:str(t?.provider), model:str(t?.model), effort:str(t?.effort)}]; }))};
}
export const modelLabel = t => [t?.provider,t?.model].filter(Boolean).join(' / ') + ' · 思考：' + (t?.effort || '模型默认');
const knownTier = (t,models) => models.some(m=>m.provider===t?.provider && m.model===t?.model && (!t.effort || m.efforts.includes(t.effort)));
export function previewModels(value, models, catalog=models) {
  const auto=value.modelMode==='auto';
  if (!models.length) return {field:auto?'autoProvider':'fast:model',error:'没有可用模型。请检查 DSH 的连接、提供方配置和授权，再刷新。'};
  const anchors = new Set(TIERS.map(([k])=>value.tiers[k].provider).filter(Boolean));
  if (auto && !value.autoProvider && !anchors.size) return {field:'autoProvider',error:'请先选择自动档位可用的提供方，不会替你跨提供方选择模型。'};
  let tiers=value.tiers;
  if (auto) {
    try {tiers=resolveTiers(value,catalog);} catch (error) {return {field:'autoProvider',error:'无法生成三档预览：'+errorMessage(error)};}
  }
  const partial={};let issue;
  for (const [key,title] of TIERS) {
    const t=tiers?.[key], anchor=value.autoProvider || value.tiers[key].provider;
    const m=models.find(m=>m.provider===t?.provider && m.model===t?.model);
    if (auto && (!anchor || t?.provider!==anchor)) issue??={field:'autoProvider',error:'「'+title+'」档缺少可用的原提供方。可明确选择其他提供方，不会自动改投。'};
    else if (!m) issue??={field:auto?'autoProvider':key+':model',error:'「'+title+'」档没有可用的模型。请核对提供方，或切到手动指定模型。'};
    else if (!knownTier(t,models)) issue??={field:auto?'autoProvider':key+':effort',error:'请为「'+title+'」档选择模型支持的思考强度。'};
    else partial[key]=t;
  }
  return issue?{...issue,partial}:{tiers};
}
// 'field' identifies the control to focus without using a remote string as a selector.
export function checkSettings(value, models, catalog=models) {
  const data = copySettings(value);
  data.generalDir = data.generalDir.trim();
  if (!absoluteDir(data.generalDir)) return {field:'generalDir', error:'请填写通用目录的绝对路径，例如 /Users/me/Work 或 D:/Work。'};
  const seen = new Set();
  for (let i = 0; i < data.projects.length; i++) {
    const p = data.projects[i]; p.path = p.path.trim();
    if (!absoluteDir(p.path)) return {field:'project:' + i, error:'项目 ' + (i+1) + ' 需要绝对目录。若不使用这一行，请移除。'};
    if (seen.has(pathKey(p.path))) return {field:'project:' + i, error:'项目目录重复：' + p.path};
    seen.add(pathKey(p.path)); p.name = p.name.trim() || shortDir(p.path);
  }
  if (data.defaultProject && !data.projects.some(p=>p.path===data.defaultProject)) return {field:'defaultProject',error:'默认项目不在已添加的项目目录中，请重新选择或留空。'};
  if (!['auto','manual'].includes(data.modelMode)) return {field:'modelMode',error:'未知模型策略，请选择自动或手动。'};
  if (!SESSION_MODES.has(data.sessionMode)) return {field:'sessionMode',error:'新会话模式不可用，请明确选择当前支持的预设或跟随 DSH 默认。'};
  const preview=previewModels(data,models,catalog);
  if (preview.error) return preview;
  // Leave even temporarily unavailable manual anchors intact across an explicit
  // auto provider change. Only an uninitialized slot needs its first value.
  if (data.modelMode==='auto') for (const [k] of TIERS) {
    if (!data.tiers[k].provider || !data.tiers[k].model) data.tiers[k]={...preview.tiers[k]};
  }
  return {data};
}
export function errorMessage(error) {
  const raw = str(error?.message || error) || '未提供错误详情';
  return /(?:\b(?:401|403)\b|unauthori[sz]ed|forbidden|permission denied|not authorized|未授权|无权限)/i.test([raw,error?.status,error?.code].join(' '))
    ? '未获授权，请检查 DSH 登录状态和访问权限。' + raw : raw;
}
export function uiKit(doc) {
  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const button = (label, handler, cls='rt-btn') => { const n = el('button', cls, label); n.type='button'; n.addEventListener('click',handler); return n; };
  const field = (label, control) => { const n=el('label','rt-field'); n.append(el('span','rt-label',label),control); return n; };
  const live = () => { const n = el('p','rt-msg'); n.hidden = true; n.setAttribute('role','status'); return n; };
  return {el,button,field,live};
}
export function text(n, value) { const v = str(value); if (n.textContent !== v) n.textContent = v; }
export function val(n, value) { if (n.value !== value) n.value = value; }
export function msg(n, value='', tone='info') {
  n.hidden = !value; n.setAttribute('data-tone', tone); n.setAttribute('role',tone === 'red' ? 'alert' : 'status'); text(n,value);
}
const opts = new WeakMap();
export function options(select, rows, value, hint) {
  const values = hint == null ? rows : [{value:'',label:hint}, ...rows];
  const signature = JSON.stringify(values);
  if (opts.get(select) !== signature) {
    select.replaceChildren(...values.map(row => {
      const n = select.ownerDocument.createElement('option'); n.value = row.value; n.textContent = row.label; n.disabled=!!row.disabled; return n;
    }));
    opts.set(select, signature);
  }
  val(select, value);
}
// Only insert/move a node when its relative order changes; avoid blurring active editors on updates.
export function order(container, nodes) {
  const keep = new Set(nodes);
  for (const n of [...container.children]) if (!keep.has(n)) n.remove();
  nodes.forEach((n,i) => { if (container.children[i] !== n) container.insertBefore(n,container.children[i] || null); });
}
export function shortcut(area, submit) {
  area.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); }
  });
}
