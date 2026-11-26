import {routingControl, sessionTargets} from './grammar.mjs';
import {catalog, follows, isGeneral, scopeFor, similarity, tierFor, chooseTier, projectHints, projectWork, actionable, wantsNew, workflowOwners} from './routing.mjs';
import {advise, bounded, LIMITS} from './inference.mjs';

const tierLabel = {fast:'快速',standard:'标准',deep:'深度'};
const blank = (text,why) => {
  const rule=tierFor(text && text.length<=LIMITS.textChars ? text : '');
  return [{key:'t1',text,project:null,tier:chooseTier(rule),dependsOn:[],decision:'clarify',candidates:[],reason:'规则：'+why+'。本次未生成可执行的路由。'}];
};
const publicProject = (path,cat) => path && cat.roots.has(path) ? path : null;
const ids = rows => [...new Set(rows.map(r=>r.s.id))].slice(0,LIMITS.candidates);
function rank(rows, st, cat) {
  return rows.map(s=>{
    let best={...similarity(st.task.text,s.title,cat),source:'标题'},witness=false;
    for(const hint of s.hints) {
      const m=similarity(st.task.text,hint,cat);
      if(m.strong && m.concrete) witness=true;
      if(m.strong && !best.strong || (m.strong===best.strong && m.score>best.score)) best={...m,source:'本地已接纳的任务原句'};
    }
    return {s,...best,witness,...(witness?{source:'本地已接纳的任务原句'}:{}),recent:[]};
  }).sort((a,b)=>Number(b.strong)-Number(a.strong) || b.score-a.score || b.s.time-a.s.time);
}
function state(task,cat) {
  const aliases=new Set([...cat.roots.values()].flatMap(names=>[...names].map(n=>n.toLowerCase())));
  const knownProject=value=>cat.roots.has(value) || value===cat.general || aliases.has(value.toLowerCase());
  const {control,quotedIds,error}=routingControl(task.text,knownProject);
  const scope=error?{paths:[],error}:scopeFor(control,cat);
  const path=!scope.error && scope.paths.length===1?scope.paths[0]:null;
  const st={task,control,quotedIds,path,scope,cont:false,forceNew:false,ranked:[],hints:[],tier:tierFor(task.text),locked:scope.error,whyPath:scope.deictic?'“这个项目”只对应一个已授权工作项目':path?'请求明确指定了已选目录':''};
  st.locked ??= st.tier.error;
  if(/(?:二选一|哪个项目|不确定(?:应|要|用|选)|还是(?:在|给|用|选|做|写|修)|或者(?:在|给|用|选|做|写|修))/u.test(control)) st.locked ??= '有未确定的备选目标；请先明确要做哪一个';
  return st;
}
function prepare(st,cat) {
  const {control}=st, {refs,malformed,multiple}=sessionTargets(control,st.quotedIds);
  function select(path,why,general=false) {
    st.path=path;st.general=general;st.whyPath=why;
    st.ranked=st.ranked.filter(r=>r.s.cwd===path);
  }
  const generalTarget=/(?:使用|用|在|放在|放到|发到|走|到)(?:已选的?|设置的?)?通用目录|通用(?:写作|问答)|(?:不涉及|不指定|无)项目/u.test(control);
  if(generalTarget && !st.locked) {
    if(!cat.general || (st.path && st.path!==cat.general)) {
      st.path=null;st.locked='通用目录未配置或同时指向其他项目，请确认唯一的目标目录';
    }
    else select(cat.general,'请求指定了通用目录',true);
  }
  st.forceNew=wantsNew(control);
  if(st.forceNew && [...control.matchAll(/(?:复用|沿用|回到|继续(?:使用)?)(?:(?:上次|之前|原来|已有|现有|刚才|那个|当前|原|旧|的)\s*)*(?:会话|对话)/gu)].some(m=>!/(?:不要|不必|别|不|避免|禁止)(?:再)?\s*$/u.test(control.slice(0,m.index)))) {
    st.locked='请求同时要求新开和使用已有会话；请明确唯一的目标';
  }
  st.cont=!st.forceNew && (follows(control.replace(/(?:上|前)一(?:个任务|步|项)(?:的)?/gu,'')) || /(?:复用|沿用)(?!.{0,3}(?:组件|模块|代码))/u.test(control));
  const rows=cat.rows.filter(s=>st.path ? s.cwd===st.path : (!st.scope.paths.length || st.scope.paths.includes(s.cwd)));
  st.ranked=rank(rows,st,cat);
  if(multiple || refs.length>1) {
    st.locked='整段请求只能发往一个会话；请选择唯一的目标会话';
    if(refs.length) st.ranked=st.ranked.filter(r=>refs.includes(r.s.id));
  } else if(malformed) {st.ranked=[];st.locked='会话标识格式不明确，请指定一个已列出的目标会话';}
  if(st.locked) { if(st.scope.error && !st.scope.paths.length) st.ranked=[]; return; }
  if(refs.length) {
    const matches=st.ranked.filter(r=>refs.includes(r.s.id));
    if(matches.length!==1 || st.forceNew || /(?:不要|别|不发到|不用).{0,10}(?:会话|对话|session)/iu.test(control)) {st.locked='指定的会话不唯一、不在所选精确目录中，或指令有冲突；请明确一个已列出的目标会话';st.ranked=matches;return;}
    st.manual=matches[0];select(st.manual.s.cwd,'请求点名了唯一候选会话');return;
  }
  if(!st.path && !st.cont && isGeneral(control)) {
    // Plain titles about a similar topic may not divert writing/Q&A from the
    // general directory. A *concrete, previously accepted* user assignment can.
    const eligible=st.forceNew?[]:st.ranked.filter(r=>r.strong && (r.witness || r.s.cwd===cat.general));
    if(eligible.length>1) {st.ranked=eligible;return;}
    if(eligible.length===1 && eligible[0].witness) select(eligible[0].s.cwd,'具体交付物与已接纳的原句吻合，沿用其工作目录',eligible[0].s.cwd===cat.general);
    else if(!cat.general) {st.locked='这是通用写作/问答，但未选定通用目录；请先配置精确目录';st.ranked=[];return;}
    else select(cat.general,'通用写作或技术问答无需接触项目',true);
  }
  // Identity evidence can identify its owning project without a magic word. Never
  // pick a directory by session date, score margin, array order or default cwd.
  if(!st.path && !st.forceNew) {
    const exact=st.ranked.filter(r=>r.strong);
    if(exact.length===1) select(exact[0].s.cwd,'从唯一的同事项证据确认了项目');
    if(exact.length>1) return;
  }
  if(!st.cont && !actionable(control) && !isGeneral(control)) {st.locked='任务本身不明确；请说明要完成的具体工作';st.ranked=[];return;}
  if(!st.path && cat.roots.size===1 && projectWork(control)) select([...cat.roots.keys()][0],'这项需要操作项目，只有一个已授权项目');
  if(!st.path && !cat.roots.size && cat.general && actionable(control)) select(cat.general,'只有一个已授权的通用工作目录',true);
  if(!st.path && cat.roots.size>1 && (projectWork(control) || st.cont)) {
    st.hints=projectHints(control,cat);
    // Soft fallback ONLY, decided after strong evidence: never prune another
    // project's candidates here.
    if(!st.path && !st.hints.length) st.workflowOwners=workflowOwners(control,cat);
    // Even a plausible project-level guess must not hide a different session's
    // independent work evidence before the bounded recent-context pass.
    if (!st.path && !st.cont && !st.hints.length && !st.ranked.some(r=>r.score>=3) && cat.defaultProject) select(cat.defaultProject,'没有其他项目或同项线索，使用你选定的默认项目');
  }
}
async function addRecent(st,cat,getRecent) {
  // Never enumerate histories to discover a project or choose the latest session.
  if (typeof getRecent!=='function' || st.locked || st.manual || st.forceNew || st.ranked.some(r=>r.strong)) return;
  const topic=st.control.replace(/继续|刚才|那个|这个|上次|之前|的|会话|项目|一下|这里|工作|任务|事情|处理|请|帮我|跟进|看一看/gu,'').trim();
  const substantive=[...cat.roots.values()].reduce((v,names)=>[...names].reduce((t,n)=>t.replaceAll(n,''),v),topic).replace(/[^\p{L}\p{N}]+/gu,'');
  if (substantive.length<3) return;
  const weak=st.ranked.filter(r=>r.score>=3);
  // Without BOTH a continuation cue and an explicit/known scope, read only
  // candidates independently shortlisted by their title/local hints. Never inspect half a tie.
  const plausible=weak.length?weak:st.cont && st.path?st.ranked:[];
  if (plausible.length>LIMITS.recentSessions) return;
  await Promise.all(plausible.map(async r=>{
    try {
      const lines=await bounded(()=>getRecent(r.s.id),LIMITS.recentMs);
      if (Array.isArray(lines)) r.recent=lines.slice(-LIMITS.recentMessages).filter(s=>typeof s==='string').map(s=>s.slice(-LIMITS.snippetChars));
    } catch { /* unavailable context is never evidence for reuse */ }
    for (const line of r.recent) {
      const hit=similarity(st.task.text,line,cat);
      if (hit.score>r.score) Object.assign(r,hit,{source:'最近摘录'});
    }
  }));
  st.ranked.sort((a,b)=>b.score-a.score || b.s.time-a.s.time);
}
function result(st,cat,model,note) {
  const {task}=st, tier=chooseTier(st.tier,model?.tier);
  const whyTier=tier===st.tier.tier ? st.tier.reason : '有限复杂度证据与模型建议共同支持'+tierLabel[tier]+'档';
  const base={...task,project:st.general?null:publicProject(st.path,cat),tier};
  const source=model?note:note.startsWith('模型')?'规则':note;
  const clarify=(why,rows=[])=>({...base,decision:'clarify',candidates:ids(rows),reason:source+'：'+why+(whyTier?'；'+whyTier:'')+'。'});
  if(st.locked)return clarify(st.locked,st.ranked);
  const reuse=(r,why)=>({...base,project:st.general?null:publicProject(r.s.cwd,cat),decision:'reuse',sessionId:r.s.id,candidates:[r.s.id],reason:source+'：'+why+'，且会话位于允许的精确目录。'+(r.s.busy?'该会话正忙，确认后应排队，不另开重复会话。':'')});
  if(st.manual)return reuse(st.manual,'请求明确点名了这个会话 ID');
  const strong=st.ranked.filter(r=>r.strong);
  if(!st.forceNew && strong.length>1)return clarify('多个会话都有同一事项的证据，不能只按最近时间或忙闲选择；请指定一个',strong);
  if(!st.forceNew && strong.length===1) {
    const r=strong[0];
    const why=r.source==='本地已接纳的任务原句'?'本地已接纳的任务原句与这次的具体对象、目标吻合，即使没有说“继续”也属于同一事项':r.source+'与请求匹配到同一具体事项「'+(r.s.title.slice(0,42)||'未命名会话')+'」';
    return reuse(r,why+(model && (model.relation!=='same' || model.row!==r)?'；采用可独立复核的唯一证据而非模型的不同或不确定建议':''));
  }
  if(!st.path && st.hints.length===1) {
    const h=st.hints[0];
    if(h.named || model?.projectHint===h || h.evidence.length>=2) {
      st.path=h.path;base.project=publicProject(st.path,cat);st.whyPath='可核验的领域或标题线索“'+h.evidence.join('、')+'”只指向该项目（不等于同一会话）';
    }
  }
  // Last resort before asking: same kind of work was admitted in exactly one
  // project. Strong same-work evidence above already had its chance.
  if(!st.path && !st.general && st.workflowOwners?.length===1) {
    st.path=st.workflowOwners[0];base.project=publicProject(st.path,cat);
    st.whyPath='同类工作此前只在这个已授权项目进行过（不等于同一会话）';
  }
  const scoped=st.path ? st.ranked.filter(r=>r.s.cwd===st.path) : st.ranked;
  const weak=scoped.filter(r=>r.score>0), shortlisted=weak.length?weak:scoped;
  if(!st.forceNew) {
    if(model?.relation==='same' && model.row && scoped.includes(model.row)) return clarify('模型提出了一个相似候选，但没有足以证明同一事项的独立证据，请确认',[model.row,...shortlisted]);
    if(st.cont) return clarify(shortlisted.length?'请求在跟进已有工作，但相似主题不足以证明是同一事项；请选择会话或补充具体目标':'请求在跟进已有工作，但没有范围内可确认的会话；请说明原工作或明确新建',shortlisted);
    // A model saying unsure with no candidate is NOT a request to choose a cwd.
    if(model?.relation==='unsure' && model.row && weak.includes(model.row)) return clarify('有相关会话但无同一事项证明；请确认是否复用或新建',[model.row,...weak]);
  }
  if(!st.path) return clarify(st.hints.length>1?'多个已选项目都包含相关线索，不能按最近会话或默认项目猜测；请指定一个':'没有与本项工作唯一对应的已授权项目线索；请选择本项目标',weak);
  const target=st.general || (!cat.roots.has(st.path) && st.path===cat.general)?'已选通用目录':'已选项目的精确目录';
  const why=st.forceNew?'用户明确要求另开会话':'没有可证明是同一事项的旧会话';
  return {...base,decision:'create',candidates:[],reason:source+'：'+why+'；'+(st.whyPath?st.whyPath+'，':'')+'在'+target+'新建；'+whyTier+'。'};
}

/**
 * Preview exactly one session target for the complete submission; never dispatch.
 * project is an allowlisted path, or null (for a general create, execute ONLY in settings.generalDir).
 * infer?: ({system:string,user:string,signal:AbortSignal}) => Promise<string>
 * getRecent?: (allowlistedSessionId:string) => Promise<string[]> (oldest first).
 * Tiers are symbols here. The host resolves settings.tiers[tier] at creation time;
 * a reused conversation keeps its own model. See inference.mjs for the JSON schema.
 */
export async function planRequest({text,settings,sessions,getRecent,infer}={}) {
  if (typeof text!=='string' || !text.trim()) return blank('', '请输入要处理的任务');
  if (text.length>LIMITS.textChars) return blank(text,'请求过长，未截断原文或传给分类器');
  // The submitted message, not a parser or a model, owns the execution payload.
  // A numbered list and its internal ordering/instructions travel to the same session.
  const task={key:'t1',text:text.trim(),dependsOn:[]};
  const cat=catalog(settings,sessions), st=state(task,cat);
  prepare(st,cat);
  if (st.locked || st.manual) return [result(st,cat,null,'规则')];
  await addRecent(st,cat,getRecent);
  const {advice,note}=await advise(st,infer,cat);
  return [result(st,cat,advice,note)];
}
