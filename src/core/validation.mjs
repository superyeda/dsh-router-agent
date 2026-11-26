import { isRouteMode } from './route-mode.mjs';
import { TIER_NAMES } from './journal.mjs';
import { modelMode, resolveTiers } from './models.mjs';

const sessionModes=new Set(['standard','ptc','inherit']);
export function creationMode(value) {
  const mode=value ?? 'standard';
  if(!sessionModes.has(mode)) throw Error('未知的新会话模式，请选择标准模式、PTC 模式或跟随 DSH 默认。');
  return mode;
}

export function directory(raw) {
  const s = String(raw ?? '').trim();
  // Do not resolve '..' or expand '~' in the browser. These are authority boundaries.
  if ((!s.startsWith('/') && !/^[a-z]:[\\/]/i.test(s)) || /[\0-\x1f]/.test(s) || s.length > 2048 || s.split(/[\\/]/).some(v => v === '..' || v === '.')) throw Error('请使用没有 . 或 .. 的绝对工作目录。');
  return s.replace(/^(.+?)[\\/]+$/, (_, head) => /^[a-z]:$/i.test(head) ? s.slice(0,3) : head);
}
export function permitted(settings) { return new Set([settings.generalDir, ...settings.projects.map(p => p.path)].filter(Boolean)); }
export function checkTier(tier, catalog) {
  const row = catalog.find(m => m.provider === tier?.provider && m.model === tier?.model);
  if (!row || (tier.effort && !row.efforts.includes(tier.effort))) throw Error('所选模型或思考强度当前不可用，请刷新并在设置中重新选择。');
  return {provider: row.provider, model: row.model, effort: tier.effort || ''};
}
export function validateSettings(raw, catalog) {
  if (!Array.isArray(raw?.projects) || raw.projects.length > 64) throw Error('请选择不超过 64 个工作目录。');
  const seen = new Set();
  const projects = raw.projects.map(p => {
    const path = directory(p.path), name = String(p.name || path.split(/[\\/]/).filter(Boolean).at(-1) || path).trim();
    if (seen.has(path)) throw Error('同一个工作目录不能重复添加。');
    if (!name || name.length > 100) throw Error('项目名称请填写 1–100 个字符。');
    seen.add(path); return {name,path};
  });
  if(raw.modelMode!=null && !['auto','manual'].includes(raw.modelMode)) throw Error('请选择自动或手动模型策略。');
  const routingMode=raw.routingMode ?? 'auto';
  if(!isRouteMode(routingMode)) throw Error('请选择有效的工作区和会话路由策略。');
  const mode=modelMode(raw),sessionMode=creationMode(raw.sessionMode);
  const autoProvider=raw.autoProvider || '';
  if(typeof autoProvider!=='string' || (mode==='auto' && autoProvider && !catalog.some(m=>m.provider===autoProvider))) throw Error('自动提供方不在当前模型目录，请重新选择。');
  const effective=resolveTiers(raw,catalog), tiers={};
  for(const k of TIER_NAMES) {
    const selected=raw.tiers?.[k];
    // Old saves were explicit three-slot choices. They cannot silently gain a
    // provider from whichever row happens to come first in the native catalog.
    if(mode==='manual' || (!raw.modelMode && !autoProvider)) tiers[k]=checkTier(selected,catalog);
    else {
      const effectiveSlot=checkTier(effective[k],catalog);
      // Explicitly selecting an auto provider must not erase manual anchors,
      // including a temporarily offline provider. They are inert data in auto
      // mode, not authority to execute an unavailable route in manual mode.
      const label=s=>typeof s==='string' && s.length>0 && s.length<=256 && s===s.trim() && !/[\u0000-\u001f\u007f]/u.test(s);
      tiers[k]=label(selected?.provider) && label(selected?.model) && (!selected.effort || label(selected.effort))
        ? {provider:selected.provider,model:selected.model,effort:selected.effort||''}:effectiveSlot;
    }
  }
  const defaultProject=raw.defaultProject ? directory(raw.defaultProject) : '';
  if(defaultProject && !seen.has(defaultProject)) throw Error('默认项目必须是当前明确添加的项目目录。');
  return {projects, generalDir: directory(raw.generalDir), defaultProject,routingMode,modelMode:mode,sessionMode,...(autoProvider?{autoProvider}:{}),tiers};
}
export function message(raw, max = 8000) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > max) throw Error('请输入 1–' + max + ' 个字符。');
  return s;
}
export function excerpt(s, n) { s = String(s ?? ''); return s.length <= n ? s : s.slice(0,n-8) + '\n…（已截短）'; }

// A planner chooses only the destination. New submissions cannot produce a
// graph, handoff, second destination or replacement for the user's message.
// Old v1 journal records are read directly; they are never re-materialized.
export function materialize(plan, settings, sessions, id, original) {
  if (!Array.isArray(plan) || plan.length!==1) throw Error('每次提交只能路由到一个会话；计划无效，未投递。');
  const p=plan[0];
  if (!p || typeof p.key!=='string' || !p.key || !Array.isArray(p.dependsOn) || p.dependsOn.length || !TIER_NAMES.includes(p.tier) || !['create','clarify','reuse'].includes(p.decision)) throw Error('单会话路由无效，未投递。');
  const text=message(original);
  if (p.text!==text) throw Error('路由未完整保留原始消息，未投递。');
  const allowed=permitted(settings), session=sessions.find(s=>s.id===p.sessionId && allowed.has(s.cwd));
  let decision=p.decision;
  const project=p.project ?? (decision==='create' ? settings.generalDir : decision==='reuse' ? session?.cwd : null);
  if (decision!=='clarify' && (!allowed.has(project) || (decision==='reuse' && session?.cwd!==project))) decision='clarify';
  const offered=sessions.filter(s=>allowed.has(s.cwd) && (!project || project===s.cwd) && Array.isArray(p.candidates) && p.candidates.includes(s.id));
  const candidates=offered.map(s=>s.id), candidateDirs=Object.fromEntries(offered.map(s=>[s.id,s.cwd]));
  const mode=creationMode(settings.sessionMode);
  return [{id:id(),text,dependsOn:[],decision,project:allowed.has(project)?project:null,tier:p.tier,sessionId:decision==='reuse'?session.id:null,candidates,candidateDirs,
    reason:decision!==p.decision?'目标不在当前许可范围，请重新选择。':excerpt(p.reason,500),status:'new',
    requestId:'ra-'+id(),createKey:'ra-'+id(),selection:{...settings.tiers[p.tier]},
    ...(decision==='reuse'?{}:{sessionMode:mode,...(mode==='inherit'?{}:{agentPreset:mode})})}];
}
