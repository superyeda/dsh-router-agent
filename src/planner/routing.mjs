// This module only reasons about supplied metadata. In particular it never resolves
// a path on the client (which need not be the same machine as the DSH host).
import {workEvidence} from './grammar.mjs';

export const TIERS = ['fast', 'standard', 'deep'];
const basename = s => s?.split(/[\\/]/u).filter(Boolean).at(-1) ?? '';
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isDir = v => typeof v === 'string' && v === v.trim() && v.length <= 1024 && /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\])/u.test(v) && !/[\x00-\x1f]/u.test(v) && !/(?:^|[\\/])\.{1,2}(?:[\\/]|$)/u.test(v);
export function catalog(settings = {}, sessions = []) {
  const roots = new Map();
  for (const p of Array.isArray(settings?.projects) ? settings.projects : []) {
    if (!p || !isDir(p.path) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 128) continue;
    if (!roots.has(p.path)) roots.set(p.path, new Set());
    roots.get(p.path).add(p.name.trim());
    const base=basename(p.path);
    if (base && base.length<=128) roots.get(p.path).add(base);
  }
  const general = isDir(settings?.generalDir) ? settings.generalDir : null;
  const seen = new Set(), duplicates = new Set(), rows = [];
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || typeof s.id !== 'string' || !s.id || s.id.length > 160) continue;
    if (seen.has(s.id)) duplicates.add(s.id);
    seen.add(s.id);
    if (!roots.has(s.cwd) && (!general || s.cwd !== general)) continue;
    const time = typeof s.updatedAt === 'number' ? s.updatedAt : Date.parse(s.updatedAt);
    // Exact ID/cwd has already been checked by the controller. Hints are local
    // admitted user requests, not fetched conversation history or model input. Never
    // use a truncated hint as identity evidence: its distinguishing suffix may matter.
    const hints=Array.isArray(s.workHints) ? s.workHints.slice(-6).filter(h=>typeof h==='string' && h.trim() && h.length<=4096) : [];
    rows.push({id:s.id,cwd:s.cwd,title:typeof s.title === 'string' ? s.title.slice(0,240) : '',hints,busy:s.busy===true,time:Number.isFinite(time)?time:0});
  }
  const defaultProject=roots.has(settings?.defaultProject)?settings.defaultProject:null;
  return {roots, general, defaultProject, rows:rows.filter(s => !duplicates.has(s.id)).sort((a,b)=>b.time-a.time || a.id.localeCompare(b.id))};
}
const boundary = s => (/[a-z0-9_./-]/i.test(s[0])?'(?<![a-zA-Z0-9_./-])':'') + esc(s) + (/[a-z0-9_./-]/i.test(s.at(-1))?'(?![a-zA-Z0-9_./-])':'');
export const wantsNew = text => /(?:另(?:开|起|建)|新(?:开|建|起)|单独(?:开|建)|创建)(?:一(?:个|条))?(?:新的?)?(?:会话|对话|聊天)|(?:不要|不必|别|不)(?:再)?复用/u.test(text);
export const follows = text => /继续|接着(?:做|改|查|修|写)|上(?:一|次|回)(?:个|的|说|那|提|没|我们)?|刚才|之前(?:的|那|提|说|没)|那个|那次|昨天(?:的|那|没)|还是上|原(?:来|先)的|跟进|接上|回到.{0,16}会话|进展(?:如何|怎样)|(?:修|做|查|写)(?:完|好)了吗|接续/u.test(text) && !wantsNew(text);
export {tierFor, chooseTier} from './complexity.mjs';
// Separate asking about technology from asking to change a local implementation.
export function isGeneral(t) {
  const qa = /解释|科普|介绍(?:一下)?|什么是|是什[么麼]|为什么|如何理解|有何区别|有什么区别|如何.{0,12}(?:工作|实现|使用|理解)|(?:该|应该|可以|能|要)?怎么(?:做|用|实现|理解|选|工作)|讲讲|回答|举.{0,2}例子|\b(?:explain|what(?:'s| is| are)|why (?:is|do)|how (?:does|do|to))\b/iu.test(t);
  const writing = /(?:写|起草|生成|编|拟|润色|修改|想|提供|给|来|做|列|整理|制作|设计|规划).{0,20}(?:邮件|信件|一封信|文章|小说|故事|文案|短文|诗|通知|提纲|祝福|标语|标题|演讲稿|邀请函|周报|日报|读书笔记|说明文|食谱|行程|建议|清单)|(?:翻译|改写|概括|总结).{0,12}(?:下[面列]|这(?:句话|段|篇)|成英文|为中文|翻成)|(?:翻译|科普)[：:\s]|(?:给|提).{0,3}(?:我|点).{0,6}建议|\b(?:write|draft|translate|rewrite)\b.{0,24}\b(?:email|poem|story|article|sentence)\b/iu.test(t);
  const privateContext=/(?:这个|当前|现有|我们(?:的)?|我们的|本|仓库内)(?:项目|仓库|工程|实现|代码|函数|接口|系统|目录)|(?:读取|打开|扫描|运行|提交|修改|编辑|删除|新增|重构|排查|修复|更新|改正|改掉|部署).{0,12}(?:代码|模块|脚本|接口|组件|用例|函数|文件|目录|仓库|构建|登录|注册|readme)|(?:\b[\w./-]+\.(?:md|m?[jt]sx?|py|json|rs|go|css|java|html|yaml|yml)\b).{0,30}(?:改|修|查|写|加|补)|(?:在|把|给|对).{0,30}\b[\w./-]+\.(?:md|m?[jt]sx?|py|json|rs|go|css|java|html|yaml|yml)\b/iu.test(t);
  return (qa || writing) && !privateContext;
}
export function actionable(t) {
  return /写|编|修|改|做|查|对账|润色|看|问|回答|解释|科普|翻译|迁移|优化|重构|对比|比较|调查|分析|设计|梳理|整理|总结|生成|实现|开发|新增|添加|创建|提交|投递|递交|网申|申请|报名|填写|上传|办理|预约|构建|部署|集成|审|评估|制作|调整|检查|准备|搭建|调试|验证|测试|跑|运行|计划|安排|列|删|安装|升级|起草|规划|接入|更新|补|研究|配置|解决|处理|跟进|\b(?:fix|add|change|replace|design|run|test|debug|optimi[sz]e|create|implement|refactor|explain|write|update|compare|review|build|draft|delete)\b/iu.test(t);
}
export function projectWork(t) {
  return !isGeneral(t) && (/模块|架构|系统|代码|脚本|程序|开发|配置|构建|编译|测试|集成|部署|设计|实现|重构|迁移|排查|开发|修复|缺陷|错误|界面|登录|支付|订单|服务|接口|修订|应用|小工具|应用程序|投递|递交|网申|简历|应聘|招聘|求职|面试|\b(?:readme|bug|api|cli|ui|css|html|typescript|debug|build|fix|implement|refactor|deploy|code|script|architecture|test|component|feature|unit test|node|python|javascript)\b|[\w./-]+\.[a-z][a-z0-9]{0,8}\b/iu.test(t));
}

// Recurring WORK is a domain, not a bare verb: 申请/填写/上传 alone can mean a
// one-off question ("如何申请病假") or work belonging to a different domain.
const workflowFamilies=[
  ['job',/投递|网申|简历|应聘|面试|招聘|校招|岗位|职位|求职|offer/iu],
  ['finance',/报销|发票|退款|对账|账务|请款|付款|差旅/iu],
  ['release',/发版|发布说明|上线|版本发布/iu],
];
export function workflowOwners(control, cat) {
  if(isGeneral(control)) return [];
  const families=workflowFamilies.filter(([,re])=>re.test(control));
  if(!families.length) return [];
  const owners=[];
  for(const path of cat.roots.keys()) {
    const rows=cat.rows.filter(r=>r.cwd===path);
    if(rows.some(r=>[r.title,...r.hints].some(s=>typeof s==='string' && families.some(([,re])=>re.test(s))))) owners.push(path);
  }
  return owners;
}

// Resolve only allowlisted exact directory strings. A name merely being a substring
// of a different project/path does not select it; equal names can be ambiguous.
export function scopeFor(text, cat) {
  // Reserve an internal placeholder; literal user text cannot impersonate an allowlist hit.
  const matched = new Set(); let marked = text.replaceAll('@target@','@literal@'), unknownPath = false;
  const roots = new Set(cat.roots.keys()); if (cat.general) roots.add(cat.general);
  for (const path of [...roots].sort((a,b)=>b.length-a.length)) {
    // The path token ends at whitespace/Chinese punctuation, never at '/' or '-'.
    const pathRe = new RegExp('(?<![a-zA-Z0-9_/.:~-])'+esc(path)+'(?=$|[\\s，。；、：,;”」』）)"\'\\x60])','gu');
    marked = marked.replace(pathRe, () => {matched.add(path); return ' @target@ ';});
  }
  const precise = new Set(matched);
  // An absolute destination not recognized above wins over any project-name match.
  // Do not confuse an HTTP URL or code symbol in prose with a directory selector.
  if (/(?:^|(?:目录|路径|cwd|切到|切换到|进入|使用目录|前往|在|到|去|从|位于|工作区|修改|更新|编辑|写入|删除|运行|检查|打开|读取|\b(?:in|at|under|into|from|edit|modify|update|read))\s*[:：=]?\s*)[\s"'“「\x60]*(?:\/(?!\/)|~\/|\.\.?\/|[A-Za-z]:[\\/]|\\\\)\S*/iu.test(marked)) unknownPath=true;
  // Be conservative on explicit standalone filesystem targets even if the verb
  // is in another clause. URLs/routes in a conceptual question aren't cwd.
  const fsText=marked.replace(/https?:\/\/[^\s，。；]+/giu,' ');
  if (actionable(fsText) && !isGeneral(fsText) && /(?:^|[\s：:=(（])(?:\/(?!\/)|~\/|\.\.\/|[A-Za-z]:[\\/]|\\\\)[^\s，。；)）]+/u.test(fsText)) unknownPath=true;
  if (unknownPath) return {paths:[],error:'提到了未选定或不完全相同的目录；请在设置中选择该精确目录，或改指已选项目'};
  const entries = [...cat.roots].flatMap(([path,names]) => [...names].map(name=>({path,name}))).sort((a,b)=>b.name.length-a.name.length);
  // Find all occurrences before replacing each name, so duplicated names remain ambiguous.
  for (const name of new Set(entries.map(p=>p.name))) {
    const re = new RegExp(boundary(name), 'giu');
    if (!re.test(marked)) continue;
    const applicable = entries.filter(p=>p.name.toLowerCase()===name.toLowerCase());
    const anchored=applicable.filter(p=>precise.has(p.path));
    for (const p of anchored.length ? anchored : applicable) matched.add(p.path);
    marked=marked.replace(re, ' @target@ ');
  }
  if (/(?:不要|不用|不在|别在|不是|不是在|不发到|排除)\s*(?:项目|仓库|工程|目录)?\s*@target@|@target@\s*(?:以外|之外|除外)/u.test(marked)) return {paths:[...matched],error:'请求排除或否定了某个候选项目，请明确实际要发送的唯一目录'};
  if (/(?:[a-zA-Z][\w.-]*|[\p{Script=Han}]{1,16})\s*(?:和|及|与|或者?|还是)\s*@target@\s*(?:项目|仓库|工程)|@target@\s*(?:还是|或(?:者)?|和|与)\s*[^，。；\s@]+\s*(?:项目|仓库|工程)/u.test(marked)) return {paths:[...matched],error:'这项提到了其他未确认的项目，请明确唯一的目标'};
  for (const m of marked.matchAll(/项目|仓库|工程/gu)) {
    const left = marked.slice(Math.max(0,m.index-32),m.index).trimEnd();
    const right = marked.slice(m.index+m[0].length,m.index+m[0].length+32).trimStart();
    if (/(?:不涉及|不指定|通用|没有关联的?|无)$/u.test(left)) continue;
    if (/@target@(?:的)?$/u.test(left) || /^[:：=名]?\s*@target@/u.test(right) || /^(?:管理|经理|成本|预算|名称)/u.test(right) || /(?:该|本|这个|当前|此|同一|同一个)$/u.test(left)) continue;
    // Generic words inside another noun do not establish a cwd.
    if (/^周报|^进度|^汇报/u.test(right) && !/(?:在|给|为|对)[^，；]{1,12}$/u.test(left)) continue;
    return {paths:[...matched],error:'提到的项目未能唯一对应到已选目录；请指明项目名或选定它的精确目录'};
  }
  if (/(?:这个|当前|本|该|此)(?:项目|仓库|工程)/u.test(marked) && !matched.size) {
    if(cat.roots.size===1 && actionable(text) && projectWork(text)) return {paths:[...cat.roots.keys()],deictic:true};
    return {paths:[],error:'尚未指明“这个项目”是哪一个；请点名已选项目或精确目录'};
  }
  if (matched.size>1) return {paths:[...matched],error:'整段请求同时指向多个已选目录；请为这条消息选择唯一的目标目录'};
  return {paths:[...matched]};
}

const generic = /(?:继续|接着|上次|上回|这次|刚才|之前|那个|目前|未完成|没做完|帮我|请你|麻烦|这个|关于|一下子?|一个|一份|一封|一篇|这份|进行|给我|再|的|就|把|将|工作|任务|会话|问题|项目|事情|相关|处理|这里|里面)/gu;
function normal(s, cat) {
  let t = s.toLowerCase().normalize('NFKC');
  for (const [dir, names] of cat.roots) {
    t=t.replaceAll(dir.toLowerCase(),' ');
    for (const n of names) t=t.replace(new RegExp(boundary(n),'giu'),' ');
  }
  return t.replace(/^\s*请(?=帮|在|给|为|把|将|写|修|改|处理|继续|新增|设计|起草|生成|检查)/u,'').replace(/修正|改正|修好/gu,'修复').replace(/编制|整理出|编写|起草|撰写|输出一份/gu,'写').replace(/小数位数|小数位|小數位/gu,'小数点').replace(/登陆/gu,'登录').replace(/安装说明|安装文档/gu,'安装').replace(/再次核验|检查一下/gu,'检查').replace(generic,' ').replace(/[^\p{L}\p{N}#/._-]+/gu,' ').trim();
}
const taskFamilies = [
  ['text',/(?:写|整理|生成|拟|制作|更新|润色|输出|做).{0,28}(?:报告|文案|邮件|说明|文章|文档|总结|周报|日报|清单|邀请函|提纲|演讲稿|祝福语|通知)|\b(?:write|draft|revise)\b.{0,25}\b(?:email|report|document)\b/u],
  ['test',/(?:写|补|新增|添加|设计|生成|完善).{0,28}(?:测试|用例)|回归测试|\b(?:test|tests)\b/u],
  ['look',/(?:解释|科普|什么是|介绍|如何理解)|\b(?:explain|what is)\b/u],
  ['edit',/改(?:成|为)|写成|替换(?:成|为)|replace\b/u],
  ['fix',/修(?:复|好|正|一下|理)?|排查|排障|错误|失败|报错|异常|故障|bug|诊断|调查|\b(?:fix|debug)\b/u],
  ['build',/实现|开发|新增|添加|搭建|创建|新建|接入|\b(?:build|implement|create|add)\b/u],
  ['change',/优化|重构|改造|迁移|调整|改进|\b(?:refactor|optimise|optimize)\b/u],
  ['check',/检查|验收|巡检|评审|复盘|审核|对账|核对|回归|审计|\b(?:review|audit|check)\b/u],
];
function family(s) { return taskFamilies.find(([,r])=>r.test(s))?.[0]; }
function grams(t) {
  const set=new Set();
  for(const p of t.match(/[\p{Script=Han}]+|[a-z0-9_./#-]+/gu)??[]) {
    if (/^[a-z0-9_./#-]/u.test(p)) {if(p.length>=2)set.add(p);continue;}
    for(let j=0;j+1<p.length;j++)set.add(p.slice(j,j+2));
  }
  return set;
}
const genericGrams=new Set('修复 排查 实现 开发 新增 添加 优化 修改 重构 测试 分析 设计 报告 总结 代码 接口 功能 登录 页面 注册 模块 错误 失败 文档 标题 导出 导入 系统 生成 创建 编写 一个 the for and this that fix error bug'.split(' '));
const joint=(a,b)=>[...a].filter(v=>b.has(v));
const setMatches=(s,re)=>new Set(s.match(re)??[]);
const sig={
  ticket:/\b[a-z][a-z\d_]*-\d+\b|#\d+\b/giu,
  file:/(?:[\w.-]+[\\/])*[\w.-]+\.(?:[cm]?[jt]sx?|md|py|go|css|json|java|rs|sql|vue|yml|yaml|html|toml|xml|csv|sh|tsx|log)\b/giu,
  status:/\b[45]\d\d\b/gu,
  date:/(?:\d{4}[-/.年])?\d{1,2}[-/.月]\d{1,2}日?|\d{4}年|\d{1,2}月|(?:周|星期)[一二三四五六日天]|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/giu,
  // One submission target per link. Extract from the ORIGINAL string so a
  // case-sensitive path or query stays distinct; end at prose punctuation.
  url:/https?:\/\/[^\s"'<>「」『』（）()【】\[\]，。；、：！？]+/gu,
  named:/[「“『"\x60]([^「“『"\x60」”』\n]{1,72})[」”』"\x60]/gu,
};
// Scheme and host are case-insensitive; the rest of a URL is not.
function normalizeUrl(u) {
  const m=/^(https?):\/\/([^/?#]+)(.*)$/iu.exec(u);
  return m ? m[1].toLowerCase()+'://'+m[2].toLowerCase()+m[3] : u;
}
function facts(s) {
  const t=s.normalize('NFKC').toLowerCase(),q=[...t.matchAll(sig.named)].map(m=>m[1].trim()).filter(Boolean);
  const url=new Set([...s.matchAll(sig.url)].map(m=>normalizeUrl(m[0].replace(/[.,;:!?]+$/u,''))));
  const dates=setMatches(t,sig.date);
  // Relative dates referring to the earlier conversation (昨天的发版检查) are
  // not deliverable dates; contrasting dates, when BOTH present, still disagree.
  for(const d of t.match(/今天|昨天|明天|本周|上周|下周|本月|上月|下月|去年|今年|明年/gu)??[])dates.add(d);
  const version=setMatches(t,/\bv\d+(?:\.\d+){0,3}\b/giu);
  const env=setMatches(t,/\b(?:linux|windows|macos|ios|android|postgresql|mysql)\b/giu);
  const position=setMatches(t,/标题|按钮|页脚|页眉|正文|侧栏|\b(?:heading|footer|header|sidebar|button)\b/giu);
  const ops=/改(?:成|为)|写成|替换(?:成|为)|\breplace\b/u.test(t);
  const namedWork=new Set([...t.matchAll(/《([^《》\n]{4,70})》/gu)].map(m=>m[1].trim()));
  return {namedWork,ticket:setMatches(t,sig.ticket),file:setMatches(t,sig.file),date:dates,status:setMatches(t,sig.status),version,env,position,quoted:new Set(q),swap:ops&&q.length>=2?q.slice(-2):null,
    url};
}
const distinct=(a,b)=>a.size && b.size && (a.size!==b.size || joint(a,b).length!==a.size);
const compareFacts=(a,b)=>['ticket','file','date','status','version','env','position','quoted','namedWork','url'].some(k=>distinct(a[k],b[k])) || (a.swap && b.swap && a.swap.some((v,i)=>v!==b.swap[i]));
const oppositeActions=[[/导入/u,/导出/u],[/登录/u,/登出|退出登录/u],[/增加|添加|新增|\badd\b/u,/删除|移除|\b(?:remove|delete)\b/u],[/启用|开启|\benable\b/u,/停用|禁用|关闭|\bdisable\b/u],[/超时/u,/重复|权限|乱码/u],[/登录/u,/注册/u],[/买入/u,/卖出/u],[/升级/u,/降级/u]];
const actor=/(?:订单|库存|发票|商品|会员|购物车|用户|客户|供应商|商家|支付|物流|退款)(?=(?:[的\s]*)(?:导出|导入|数据|接口|记录|报表|汇总|模块|列表|金额|状态|缓存|功能|邮件|计划|报告|周报|操作|页面|统计|日结|日报))/gu;
function differentObject(a,b) {
  if (distinct(setMatches(a,actor),setMatches(b,actor))) return true;
  return oppositeActions.some(([p,q])=> (p.test(a) && !q.test(a) && q.test(b) && !p.test(b)) || (p.test(b) && !q.test(b) && q.test(a) && !p.test(a)));
}
export function similarity(request, source, cat) {
  if(!source || !request) return {strong:false,score:0};
  const {visible,opaque}=workEvidence(request),{visible:prior,opaque:other}=workEvidence(source);
  // Hiding code/quoted examples must not make two DIFFERENT payloads look
  // like the same job merely because both say “fix this sample”.
  if (opaque.length && other.length && (opaque.length!==other.length || opaque.some((s,i)=>s!==other[i]))) return {strong:false,score:0};
  const a=normal(visible,cat),b=normal(prior,cat), fa=family(a),fb=family(b), agree=fa && fa===fb;
  const ag=grams(a),bg=grams(b),overlap=joint(ag,bg), subject=overlap.filter(g=>!genericGrams.has(g));
  const af=facts(visible),bf=facts(prior),tickets=joint(af.ticket,bf.ticket),files=joint(af.file,bf.file),codes=joint(af.status,bf.status);
  // Quoted replacements, files, dates and URLs can rule OUT a match. But an
  // example mentioning a ticket/session is not affirmative evidence to reuse it.
  const rawA=visible===request?af:facts(request),rawB=prior===source?bf:facts(source);
  if (compareFacts(rawA,rawB) || differentObject(a,b) || (fa && fb && fa!==fb) || /不同(?:功能|目标|任务)|另一(?:件事|个问题|个需求|项工作)|不(?:是|接着)上次/u.test(visible)) return {strong:false,score:0};
  // The same complete application target plus the same kind of action is the
  // same work even when the wording differs. A query/cancel request about the
  // same link is NOT: the action must stay in the apply family on both sides.
  const applyAction=/投递|网申|报名|应聘|递交|申请/u, notApply=/撤回|撤销|取消|删除|查询|查看|进度|状态|结果|修改|更新|替换/u;
  if (af.url.size===1 && bf.url.size===1 && joint(af.url,bf.url).length===1
    && applyAction.test(visible) && applyAction.test(prior)
    && !notApply.test(visible) && !notApply.test(prior)) return {strong:true,score:6,urlSame:true};
  const x=a.replace(/\s+/gu,'').replace(/^(?:先在|在|为|给|对|跟进)/u,'').replace(/^(?:昨天|前天|刚才)/u,''),y=b.replace(/\s+/gu,'').replace(/^(?:在|为|给|对)/u,'').replace(/^(?:昨天|前天|刚才)/u,'');
  const exact=x===y && x.length>=4 && ((agree && subject.length) || (x.length>=8 && subject.length>=3));
  const sameEdit=files.length && rawA.swap && rawB.swap && (joint(af.env,bf.env).length || subject.length>=3);
  const contained=x && y && (x.includes(y)||y.includes(x)) && Math.min(x.length,y.length)>=5 && agree && subject.length>=2;
  const ratio=overlap.length/Math.max(1,ag.size,bg.size);
  const sameStatus=codes.length && agree && (ratio>=0.7 || ((x.includes(y)||y.includes(x)) && overlap.length>=3));
  const near=agree && ratio>=0.67 && subject.length>=3 && (files.length || !af.file.size && !bf.file.size);
  const named=agree && [...af.namedWork,...bf.namedWork].some(v=>v.length>=5 && (af.namedWork.has(v) || visible.toLowerCase().includes(v)) && (bf.namedWork.has(v) || prior.toLowerCase().includes(v)));
  const unmatchedLiteral=Boolean(opaque.length)!==Boolean(other.length);
  const strong=Boolean((!unmatchedLiteral || tickets.length || files.length || codes.length || named) && (tickets.length || named || exact || sameEdit || contained || sameStatus || near));
  const concrete=Boolean(named || tickets.length || files.length || codes.length || x.length>=10 && y.length>=10 && subject.length>=4);

  return {strong,concrete,score:(strong?100:0)+(subject.length?subject.length*2+overlap.length:Math.min(2,overlap.length))+files.length*3+codes.length*2};
}

// Project identity is not conversation identity. A distinctive module, full file
// name or technology can identify ONE project for *new* work; a generic topic or
// a single recent candidate cannot. Returned material contains labels, never cwd.
const topicStop=new Set([...genericGrams,...'项目 仓库 请求 代码 审查 服务 管理 工具 数据 文件 缓存 缺陷 问题 整理 日报 系统 平台 流程 处理 编译 运行 界面 中文 英文 新增 编辑 操作 client server service project test src index main docs readme.md'.split(' ')]);
// A URL is not a topical concept: protocol, common hosts/TLDs, file suffixes and
// opaque ids must not each count as separate project evidence.
const urlNoise=/^(?:https?|www|com|cn|net|org|io|gov|edu|html?|php|aspx?|invalid|example|localhost)$/iu;
const opaqueId=/^(?:[0-9a-f]{8,}|[a-z]*\d{4,})$/iu;
function topics(text, title=false) {
  const words=new Set();
  const prose=text.replace(/https?:\/\/\S+/giu,' ');
  for(const w of prose.toLowerCase().match(/[a-z][a-z0-9_.-]{2,47}|[\p{Script=Han}]+/gu)??[]) {
    if (topicStop.has(w) || urlNoise.test(w) || opaqueId.test(w)) continue;
    if (/^[a-z]/u.test(w)) {if(!title || /[\d_.-]/u.test(w) || w.length>=5)words.add(w); continue;}
    for(const key of w.match(/支付|结算|对账|发票|退款|物流|库存|仓储|地图|地理编码|图层|坐标|检索|搜索|索引|认证|鉴权|签名|账单|账务|汇率|绘图|渲染|视频|音频|编解码|订单|导出|导入|优惠券|会员|天气|预报/gu)??[]) if(!topicStop.has(key))words.add(key);
  }
  return words;
}
export function projectHints(control, cat) {
  const req=topics(control), out=[];
  for(const [path,aliases] of cat.roots) {
    const labels=[...aliases].filter(s=>s && !/[\\/]/u.test(s)).map(s=>s.slice(0,64));
    const named=new Set(labels.flatMap(s=>[...topics(s)]));
    const anchors=new Set(joint(req,named)),namedEvidence=anchors.size>0;
    for(const s of cat.rows.filter(r=>r.cwd===path)) {
      const shared=joint(req,topics(s.title,true));
      for(const x of shared) {
        // A title alone gives project-level authority only for an exact uncommon
        // symbol/file or two topical concepts, not e.g. a stray 登录 or 订单.
        if (/^[a-z]/u.test(x) || shared.length>=2) anchors.add(x);
      }
    }
    if (anchors.size) out.push({path,labels,named:namedEvidence,evidence:[...anchors].slice(0,6)});
  }
  return out;
}
