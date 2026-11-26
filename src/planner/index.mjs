import {isAutomaticRoute} from '../core/route-mode.mjs';
import {routingControl, sessionTargets, routingHold, continuation} from './grammar.mjs';
import {catalog, follows, isGeneral, scopeFor, similarity, tierFor, chooseTier, projectHints, projectWork, actionable, wantsNew, workflowOwners, autoProjectHints} from './routing.mjs';
import {advise, bounded, LIMITS} from './inference.mjs';

const tierLabel = {fast:'快速',standard:'标准',deep:'深度'};
const blank = (text,why) => {
  const rule=tierFor(text && text.length<=LIMITS.textChars ? text : '');
  return [{key:'t1',text,project:null,tier:chooseTier(rule),dependsOn:[],decision:'clarify',candidates:[],reason:'规则：'+why+'。本次未生成可执行的路由。'}];
};
const publicProject = (path,cat) => path && cat.roots.has(path) ? path : null;
const ids = rows => [...new Set(rows.map(r=>r.s.id))].slice(0,LIMITS.candidates);
// No native timestamp participates in a decision. Read the maximum before any
// scope filter; a filtered-out or tied local winner must not promote another row.
function localLatest(rows) {
  let time=0, winner=null;
  for(const s of rows) if(Number.isSafeInteger(s.lastRoutedAt) && s.lastRoutedAt>0) {
    if(s.lastRoutedAt>time) {time=s.lastRoutedAt;winner=s;}
    else if(s.lastRoutedAt===time) winner=null;
  }
  return winner;
}
const byEvidence=(a,b)=>Number(b.strong)-Number(a.strong) || b.score-a.score || a.s.id.localeCompare(b.s.id);
const relevant=hit=>hit.strong || hit.supported || hit.score>=3;
function incorporate(row,hit,source) {
  if(hit.conflict) row.conflict=true;
  if(hit.supported) row.supported=true;
  if(hit.strong && !row.strong || (!!hit.strong===row.strong && hit.score>row.score)) {
    row.strong=!!hit.strong;row.score=hit.score;row.source=source;
  }
}
function rank(rows,st,cat) {
  return rows.map(s=>{
    const title=similarity(st.task.text,s.title,cat);
    const r={s,strong:false,score:0,conflict:false,supported:false,witness:false,source:'标题',titleRelevant:!!(title.strong || title.supported),recent:[]};
    incorporate(r,title,'标题');
    for(const hint of s.hints) {
      const hit=similarity(st.task.text,hint,cat);
      // Hints arrive oldest first. The newest concrete, accepted assignment
      // can supersede a stale title/older object. A more recent factual clash
      // conversely disqualifies that stale match. Unrelated hints prove neither.
      if(hit.strong && (hit.concrete || hit.urlSame) && !hit.conflict) {r.witness=true;r.conflict=false;}
      incorporate(r,hit,'本地已接纳的任务原句');
    }
    // A stale matching title cannot overrule the accepted job's different
    // concrete object (e.g. a URL differing only by query value).
    if(r.conflict) {r.strong=false;r.supported=false;r.witness=false;r.score=0;}
    else if(r.witness) r.source='本地已接纳的任务原句';
    return r;
  }).sort(byEvidence);
}
function state(task,cat,auto) {
  const aliases=new Set([...cat.roots.values()].flatMap(names=>[...names].map(n=>n.toLowerCase())));
  const knownProject=value=>cat.roots.has(value) || value===cat.general || aliases.has(value.toLowerCase());
  const {control,quotedIds,error}=routingControl(task.text,knownProject);
  const scope=error?{paths:[],error}:scopeFor(control,cat,{auto});
  const path=!scope.error && scope.paths.length===1?scope.paths[0]:null;
  const st={task,auto,control,quotedIds,path,scope,cont:false,forceNew:false,ranked:[],hints:[],tier:tierFor(task.text),locked:scope.error,whyPath:scope.deictic?'“这个项目”只对应一个已授权工作项目':path?'请求明确指定了已选目录':''};
  st.locked ??= st.tier.error ?? routingHold(control);
  // “用低档和深度档” shares one selector across two explicit labels. Let the
  // actual tier grammar validate both (including literals and example clauses).
  const paired=/(使用|选择|指定|采用|用)\s*((?:快速|极速|轻量|标准|普通|深度|低|中|高)档)\s*(?:和|与|及|、)\s*((?:快速|极速|轻量|标准|普通|深度|低|中|高)档)/u;
  if(!st.locked && paired.test(control)) st.locked=tierFor(task.text.replace(paired,'$1$2，$1$3，')).error;
  if(!auto && /(?:二选一|哪个项目|不确定(?:应|要|用|选)|还是(?:在|给|用|选|做|写|修)|或者(?:在|给|用|选|做|写|修))/u.test(control)) st.locked ??= '有未确定的备选目标；请先明确要做哪一个';
  return st;
}
function prepare(st,cat) {
  const {control}=st, {refs,malformed,multiple}=sessionTargets(control,st.quotedIds);
  function select(path,why,general=false) {
    st.path=path;st.general=general;st.whyPath=why;
    st.ranked=st.ranked.filter(r=>r.s.cwd===path);
  }
  const generalTarget=/(?:使用|用|在|放在|放到|发到|走|到)(?:已选的?|设置的?)?通用(?:目录|工作区)|通用(?:写作|问答)|(?:不涉及|不指定|无)项目|\b(?:in|into|use) (?:the )?general (?:workspace|directory)\b/iu.test(control);
  const defaultTarget=/(?:使用|用|在|放到|发到|到|去|给)(?:已选的?|设置的?)?默认(?:的)?(?:项目|工作区|仓库|目录)|\b(?:in|into|use) (?:the )?default (?:workspace|project)\b/iu.test(control);
  if(st.auto && defaultTarget && !st.locked) {
    if(!cat.defaultProject || (st.path && st.path!==cat.defaultProject)) {st.path=null;st.locked='请求指定的默认项目未设置或与其他明确目标冲突，请确认目录';}
    else select(cat.defaultProject,'请求明确指定了已配置的默认项目');
  }
  if(/(?:别|不要|不用|禁止|排除|不在)(?:再)?(?:发送到|发到|选择|使用|在|用|到)?(?:已选的?)?通用(?:目录|工作区)/u.test(control)) st.locked??='请求否定了通用目录，请明确唯一的实际目标';
  if(generalTarget && !st.locked) {
    if(!cat.general || (st.path && st.path!==cat.general)) {
      st.path=null;st.locked='通用目录未配置或同时指向其他项目，请确认唯一的目标目录';
    }
    else select(cat.general,'请求指定了通用目录',true);
  }
  // Negated new/reuse and a named destination are instructions, not model hints.
  const noNew=/(?:不要|不必|不用|不能|别|禁止)(?:再)?(?:新[开建起]|另[开建起]|创建)(?:一[个条])?(?:新的?)?(?:会话|对话|聊天)/gu;
  const positive=control.replace(noNew,' '), reuseOnly=positive!==control;
  const follow=continuation(control,st.task.text,st.path?[st.path,...(cat.roots.get(st.path)??[])]:[]);
  const deniedSession=/(?:不要|不必|不用|不能|别|勿|排除|禁止|避免|不)(?:再)?(?:继续(?:使用|用)?|复用|沿用|回到|发送到|发到|发往|使用|用|去)?(?:上次|之前|已有|现有|刚才|指定的?|这(?:个|条)?|那(?:个|条)?|当前|原|旧|的|\s)*(?:会话|对话)|\b(?:do not|don't|never|avoid) (?:use|reuse|resume|return to|send to) (?:the |this |that |previous )*session\b/iu.test(positive);
  const explicitNew=wantsNew(positive) || deniedSession;

  st.forceNew=explicitNew || follow.previousExcluded;
  if(reuseOnly && st.forceNew) st.locked='不能同时新建并禁止新建会话，请确认唯一目标';
  if(explicitNew && [...control.matchAll(/(?:复用|沿用|回到|继续(?:使用)?)(?:(?:上次|之前|原来|已有|现有|刚才|那个|当前|原|旧|的)\s*)*(?:会话|对话)/gu)].some(m=>!/(?:不要|不必|别|不|避免|禁止)(?:再)?\s*$/u.test(control.slice(0,m.index)))) {
    st.locked='请求同时要求新开和使用已有会话；请明确唯一的目标';
  }
  st.pure=st.auto && follow.pure;
  st.cont=!st.forceNew && (reuseOnly || (st.auto ? follow.follow : follows(control.replace(/(?:上|前)一(?:个任务|步|项)(?:的)?/gu,'')) || /(?:复用|沿用)(?!.{0,3}(?:组件|模块|代码))/u.test(control)));
  const rows=cat.rows.filter(s=>st.path ? s.cwd===st.path : (!st.scope.paths.length || st.scope.paths.includes(s.cwd)));
  st.ranked=rank(rows,st,cat);
  if(multiple || refs.length>1) {
    st.locked='整段请求只能发往一个会话；请选择唯一的目标会话';
    if(refs.length) st.ranked=st.ranked.filter(r=>refs.includes(r.s.id));
  } else if(malformed) {st.ranked=[];st.locked='会话标识格式不明确，请指定一个已列出的目标会话';}
  if(st.locked) { if(st.scope.error && !st.scope.paths.length) st.ranked=[]; return; }
  if(refs.length) {
    const matches=st.ranked.filter(r=>refs.includes(r.s.id));
    if(matches.length!==1 || explicitNew) {st.locked='指定的会话不唯一、不在所选精确目录中，或指令有冲突；请明确一个已列出的目标会话';st.ranked=matches;return;}
    st.manual=matches[0];select(st.manual.s.cwd,'请求点名了唯一候选会话');return;
  }
  if(st.auto) {
    st.latest=localLatest(cat.rows);
    if(st.scope.deictic) st.ranked=st.ranked.filter(r=>cat.roots.has(r.s.cwd));
    if(!st.path) {
      st.hints=autoProjectHints(control,cat,st.task.text);
      st.generalQuestion=/^(?:\s*(?:请问(?:一下)?[，,]?|想知道|我想了解|请解释|为什么|为何|怎样|如何|怎么|什么是|\b(?:explain|how (?:do|to|can)|what (?:is|are)|why (?:do|is))\b))/iu.test(control);
      // A writing/Q&A assignment must not be captured by an unrelated native
      // title in a project. An actual same-work admission there is different.
      st.generalIntent=!st.scope.deictic && !st.cont && (isGeneral(control,{auto:true}) || st.generalQuestion);
      if(st.generalIntent) st.ranked=st.ranked.filter(r=>r.s.cwd===cat.general || r.witness);
    }
    return;
  }
  // Confirm keeps v0.2.0's conservative policy for ambiguous input only.
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
  // No history sweep. For a pointer the missing fact is journal provenance,
  // not somebody's latest transcript; a conflict is also not a reason to read.
  if(typeof getRecent!=='function' || st.locked || st.manual || st.forceNew || st.pure || st.ranked.some(r=>r.strong)) return;
  const topic=st.control.replace(/继续|刚才|那个|这个|上次|之前|的|会话|项目|一下|这里|工作|任务|事情|处理|请|帮我|跟进|看一看/gu,'').trim();
  const substantive=[...cat.roots.values()].reduce((v,names)=>[...names].reduce((t,n)=>t.replaceAll(n,''),v),topic).replace(/[^\p{L}\p{N}]+/gu,'');
  if(substantive.length<3) return;
  const eligible=st.ranked.filter(r=>!r.conflict), weak=eligible.filter(relevant);
  const plausible=weak.length ? weak : st.cont && st.path ? eligible : [];
  if(plausible.length>LIMITS.recentSessions) return;
  await Promise.all(plausible.map(async r=>{
    try {
      const lines=await bounded(()=>getRecent(r.s.id),LIMITS.recentMs);
      if(!Array.isArray(lines)) return;
      for(const raw of lines.slice(-LIMITS.recentMessages)) {
        if(typeof raw!=='string') continue;
        const line=raw.slice(-LIMITS.snippetChars),hit=similarity(st.task.text,line,cat);
        // An unrelated line in a scoped read is not material to send to a
        // classifier. Local negative facts cannot turn into a positive quote.
        if(!hit.conflict && (st.auto?hit.strong || hit.supported:relevant(hit))) r.recent.push(line);
        incorporate(r,hit,'最近摘录');
      }
    } catch { /* unavailable history is not affirmative evidence */ }
    if(r.conflict) {r.strong=false;r.supported=false;r.score=0;r.recent=[];}
  }));
  st.ranked.sort(byEvidence);
}

// A greeting alone has no project subject. Keep this narrow: ordinary neutral
// prose can describe work which ONLY a model can associate with a project label.
const greeting = t=>/^(?:你好|您好|谢谢|hi|hey|hello|thanks)[\s，。！？,.!?]*$/iu.test(t.trim());
function tierAdviceMatters(st,tiers) {
  if(st.tier.fixed) return false;
  // Don't buy a round of classification merely to demote a short, standalone
  // general question from standard to fast. Same-work and project evidence
  // are checked separately and still take priority over this latency policy.
  const simpleQuestion=(st.generalIntent || isGeneral(st.control,{auto:true})) &&
    (st.generalQuestion || /[?？]|解释|科普|讲讲|什么是|是什么|如何|怎么|\b(?:what|why|how|explain)\b/iu.test(st.control));
  if(greeting(st.control) || (simpleQuestion && !st.hints.length && st.task.text.length<=120 && !/[;；\n]/u.test(st.control))) return false;
  const base=chooseTier(st.tier), a=tiers?.[base];
  // The controller supplies resolved selections. With no valid table, retain
  // the symbolic tier choice rather than treating two missing slots as equal.
  return Object.keys(tierLabel).some(t=>{
    const next=chooseTier(st.tier,t), b=tiers?.[next];
    return base!==next && !(a?.provider && a.model && a.provider===b?.provider && a.model===b.model && (a.effort??'')===(b.effort??''));
  });
}

// Return a cwd, not an instruction to reuse any conversation in it. A model
// can only return an index into its bounded local proposal table (inference).
function autoDirectory(st,cat,model,strong,probe) {
  if(st.path) return {path:st.path,why:st.whyPath,general:st.general};
  const owners=new Set(strong.map(r=>r.s.cwd));
  if(owners.size===1) return {path:[...owners][0],why:'候选会话虽不唯一，其同事项证据都属于同一个工作目录'};
  const hinted=st.hints.filter(h=>h.credible && (!st.generalIntent || !st.generalQuestion && h.named));
  const plausible=new Set(hinted.map(h=>h.path));
  if(plausible.size===1) {
    const [path]=plausible, h=hinted.find(h=>h.path===path);
    return {path,why:'可核验的项目领域线索“'+h.evidence.join('、')+'”只指向该项目'};
  }
  // Do not infer a destructive destination merely from list order. This is a
  // routing guard, not a substitute for the target session's normal approvals.
  const destructive=!(st.generalIntent || /(?:讨论|解释|讲讲|怎么|如何|怎样|是否应该|什么是).{0,12}(?:清空|删除|覆盖)/u.test(st.control)) && /(?:把|将)?(?:库里(?:的)?所有数据|所有(?:数据库)?表|全部(?:生产)?数据|整个生产(?:环境|数据库|数据)).{0,4}(?:都|全部)?(?:删掉|删除|清空|抹除|覆盖|销毁)|(?:清空|删(?:除|掉)|抹(?:除|掉)|销毁).{0,8}(?:数据库|库里(?:的)?所有数据|全(?:部|库)(?:数据|记录)|所有(?:生产)?数据)|(?:强制覆盖|覆盖|重置|清空)(?:整个)?生产(?:环境|数据库|数据)|\b(?:drop\s+(?:the\s+)?database|wipe (?:all|the production) data)\b/iu.test(st.control);
  if(destructive && !st.scope.deictic && !cat.defaultProject && cat.roots.size>1) return {error:'这是大范围不可逆操作，没有明确或默认的工作目录；请先指定目标'};
  if(!destructive && model?.projectHint && (!plausible.size || plausible.has(model.projectHint.path))) {
    return {path:model.projectHint.path,why:'可核验的请求线索与该已授权项目的短标签或证据语义吻合，模型引用已经核验'};
  }
  // A fallback is not itself evidence. In the local probe, let any other
  // plausibly offerable project through to the bounded, quote-checked advisor.
  // One work project can still displace a *different* general fallback.
  function fallback(path,why,general=false) {
    if(probe && !destructive && !greeting(st.control)) {
      const options=st.generalIntent ? st.hints.filter(h=>!st.generalQuestion && h.named).map(h=>h.path)
        : st.scope.deictic ? st.hints.map(h=>h.path) : [...cat.roots.keys()];
      if(options.some(p=>p!==path)) return null;
    }
    return {path,why,general};
  }
  if(st.scope.deictic) {
    if(st.latest && cat.roots.has(st.latest.cwd)) return fallback(st.latest.cwd,'“这个项目”指向本路由台最近实际接纳工作的项目');
    if(cat.defaultProject) return fallback(cat.defaultProject,'“这个项目”采用你选定的默认项目');
    return {error:'尚无能指明“这个项目”的本地上下文、默认项目或独立线索，请确认目录'};
  }
  const projectFirst=!st.generalIntent && (projectWork(st.control.replace(/设计|制作|规划|申请/gu,''),{auto:true}) || destructive || plausible.size>0);
  if(!projectFirst && cat.general) return fallback(cat.general,'没有专属项目证据，通用问答、写作或中性请求使用已配置的通用目录',true);
  if(cat.defaultProject) return fallback(cat.defaultProject,'没有唯一项目线索，使用你选定的默认项目');
  if(cat.roots.size) return fallback(cat.roots.keys().next().value,cat.roots.size===1?'只有一个已授权工作项目':'未设默认项目，按配置顺序使用第一个已授权项目');
  if(cat.general) return fallback(cat.general,'只有一个已授权的通用工作目录',true);
  return {error:'还没有可用的已授权目录，请先在设置中选择工作目录'};
}
// In a local automatic probe, yield null at a decision an advisory reply
// could change. Do not use a speculative cwd to narrow the later model input.
function result(st,cat,model,note,probe) {
  const {task}=st, tier=chooseTier(st.tier,model?.tier);
  const whyTier=tier===st.tier.tier ? st.tier.reason : '有限复杂度证据与模型建议共同支持'+tierLabel[tier]+'档';
  const base={...task,project:st.general?null:publicProject(st.path,cat),tier};
  const source=model?note:note.startsWith('模型')?'规则':note;
  const clarify=(why,rows=[])=>({...base,decision:'clarify',candidates:ids(rows),reason:source+'：'+why+(whyTier?'；'+whyTier:'')+'。'});
  if(st.locked)return clarify(st.locked,st.ranked);
  const reuse=(r,why)=>({...base,project:st.general?null:publicProject(r.s.cwd,cat),decision:'reuse',sessionId:r.s.id,candidates:[r.s.id],reason:source+'：'+why+'，且会话位于允许的精确目录。'+(r.s.busy?'该会话正忙，本条消息应排队，不另开重复会话。':'')});
  if(st.manual)return reuse(st.manual,'请求明确点名了这个会话 ID');
  const strong=st.ranked.filter(r=>r.strong);
  const current=st.latest && st.ranked.find(r=>r.s===st.latest && !r.conflict);
  if(!st.forceNew && st.pure) {
    if(current) return reuse(current,'这是一条承接上一轮的短消息，本路由台最近实际接纳的唯一上下文可以确定它的指代');
    if(st.scope.paths.length===1 && !st.scope.deictic && st.ranked.length===1 && !st.ranked[0].conflict) return reuse(st.ranked[0],'你明确要求继续所点名项目的工作，且其中只有这一个候选会话');
    return clarify('请求承接上一轮，但没有唯一、仍在范围内的最近本地上下文；请确认原会话',st.ranked.filter(r=>!r.conflict));
  }
  if(!st.forceNew && strong.length>1) {
    if(st.auto && strong.includes(current)) return reuse(current,'多个候选有同项证据，其中只有这个也是本路由台最近实际接纳的上下文');
    if(!st.auto || st.cont) return clarify('多个会话都有同一事项的证据，不能只按最近时间或忙闲选择；请指定一个',strong);
    // Without a unique referent, an ordinary submission is new work. Never
    // allow a model or list ordering to break this unresolved identity tie.
  }
  if(!st.forceNew && strong.length===1) {
    const r=strong[0];
    const why=r.source==='本地已接纳的任务原句'?'本地已接纳的任务原句与这次的具体对象、目标吻合，即使没有说“继续”也属于同一事项':r.source+'与请求匹配到同一具体事项「'+(r.s.title.slice(0,42)||'未命名会话')+'」';
    return reuse(r,why+(model && (model.relation!=='same' || model.row!==r)?'；采用可独立复核的唯一证据而非模型的不同或不确定建议':''));
  }
  if(st.auto) {
    if(!st.forceNew && !strong.length) {
      const supported=st.ranked.filter(r=>r.supported && !r.conflict);
      const candidate=supported.length===1 ? supported[0] : supported.includes(current) ? current : null;
      if(candidate && model?.relation==='same' && model.row===candidate && model.quotesSupport) {
        return reuse(candidate,'模型引用经核验，并有独立的具体对象证据支持同一事项');
      }
      if(st.cont && current?.supported) return reuse(current,'明确的跟进指令、独立具体对象和最近本地接纳记录指向同一事项');
      if(probe && candidate && (candidate.titleRelevant || candidate.recent.length)) return null;
      if(st.cont) {
        const eligible=st.ranked.filter(r=>!r.conflict), weak=eligible.filter(r=>r.score>0);
        return clarify('你明确要求跟进已有工作，但缺少足以区分原事项的证据；请确认原会话或明确新建',weak.length?weak:eligible);
      }
    }
    const dir=autoDirectory(st,cat,model,strong,probe);
    if(!dir) return null;
    if(dir.error) return clarify(dir.error);
    if(probe && tierAdviceMatters(st,probe.tiers)) return null;
    st.path=dir.path;st.general=!!dir.general;st.whyPath=dir.why;base.project=st.general?null:publicProject(dir.path,cat);
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
  if(!st.forceNew && !st.auto) {
    if(model?.relation==='same' && model.row && scoped.includes(model.row)) return clarify('模型提出了一个相似候选，但没有足以证明同一事项的独立证据，请确认',[model.row,...shortlisted]);
    if(st.cont) return clarify(shortlisted.length?'请求在跟进已有工作，但相似主题不足以证明是同一事项；请选择会话或补充具体目标':'请求在跟进已有工作，但没有范围内可确认的会话；请说明原工作或明确新建',shortlisted);
    // A model saying unsure with no candidate is NOT a request to choose a cwd.
    if(model?.relation==='unsure' && model.row && weak.includes(model.row)) return clarify('有相关会话但无同一事项证明；请确认是否复用或新建',[model.row,...weak]);
  }
  if(!st.path) return clarify(st.hints.length>1?'多个已选项目都包含相关线索，不能按最近会话或默认项目猜测；请指定一个':'没有与本项工作唯一对应的已授权项目线索；请选择本项目标',weak);
  const target=st.general || (!cat.roots.has(st.path) && st.path===cat.general)?'已选通用目录':'已选项目的精确目录';
  const why=st.forceNew?'请求指定新工作或排除了原会话':'没有可唯一确定为同一事项的旧会话';
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
  const cat=catalog(settings,sessions), st=state(task,cat,isAutomaticRoute(settings));
  prepare(st,cat);
  if (st.locked || st.manual || st.pure) return [result(st,cat,null,'规则')];
  await addRecent(st,cat,getRecent);
  if(st.auto && typeof infer==='function') {
    const local=result({...st},cat,null,'规则',{tiers:settings?.tiers});
    if(local && local.decision!=='clarify') return [local];
  }
  const {advice,note}=await advise(st,infer,cat);
  return [result(st,cat,advice,note)];
}
