// Project affinity, not conversation identity. Only inspect supplied metadata; do
// not open a workspace, fetch a URL or treat a journal entry as an address.
import {workEvidence} from './grammar.mjs';

// A finite bilingual *concept* vocabulary, supplemented by open-vocabulary
// compound names below. An alias match counts once, not as N independent votes.
// Deliberately absent as stand-alone signals: 申请, 表单, 页面, bug, system, etc.
const vocabulary = {
  forms: {
    autofill: /自动(?:填写|填充|填表|回填|补全(?:表单|字段))|(?:表单|字段)回填|\bauto[ _-]?fill(?:er|ing)?\b|\bpre[ -]?fill(?:ed|ing)?\b/iu,
    fields: /字段映射|填表助手|表单预填|\bfield mapping\b/iu,
  },
  hiring: {
    application: /网申|投(?:递)?简历|简历投递|求职申请|应聘|(?:job|campus) applications?|apply (?:to|for) (?:a |the )?(?:job|position)/iu,
    resume: /简历|履历|\br[eé]sum[eé]s?\b|\bcurriculum vitae\b/iu,
    recruiting: /求职|招聘|校招|社招|\b(?:jobs?|hiring|recruit(?:ing|ment)?|careers?)\b/iu,
    interview: /面试|\b(?:job|technical) interviews?\b/iu,
  },
  billing: {
    billing: /账单|帐单|账务|帐务|\bbilling\b|\baccounting\b/iu,
    invoice: /发票|開票|开票|开具票据|\binvoic(?:e[sd]?|ing)\b/iu,
    ledger: /对账|对帐|核账|账本|总账|\b(?:reconcil(?:e|iation)|ledgers?)\b/iu,
    refund: /退款|退费|\brefunds?\b/iu,
    expense: /报销|报账|\b(?:expenses?|reimbursements?)\b/iu,
    tax: /税额|税率|增值税|\b(?:sales tax|vat)\b/iu,
  },
  web: {
    frontend: /前端|网页|浏览器端|\b(?:web|front[ _-]?end|website)\b/iu,
    layout: /响应式|小屏(?:幕)?(?:布局|适配)|移动端适配|样式表|\b(?:css|stylesheet|responsive)\b/iu,
    nav: /导航栏|导航菜单|\bnav(?:igation ?)?bar\b/iu,
    rendering: /首屏|白屏|服务端渲染|\b(?:hydration|dom|lighthouse)\b/iu,
  },
  geo: {mapping:/地理编码|地图|\b(?:geocod(?:e|ing)|maps?|gis)\b/iu, layer:/图层|经纬度|地理坐标|\bmap tiles?\b/iu},
  warehouse: {stock:/仓储|库存|\b(?:warehouse|inventory)\b/iu, storage:/入库|出库|库位|\bstocktaking\b/iu},
  access: {auth:/鉴权|身份认证|\b(?:auth|authentication|oauth2?|oidc)\b/iu, sso:/单点登录|\b(?:sso|single sign[ -]?on)\b/iu},
  search: {retrieval:/检索|搜索引擎|\b(?:retrieval|search)\b/iu, indexing:/倒排索引|分词器|\b(?:tokenizer|inverted index)\b/iu},
  release: {release:/发版|发布说明|版本发布|\brelease(?: notes)?\b/iu, rollout:/灰度发布|分批上线|\bcanary rollout\b/iu},
};

// A label must be a short display name, not an address, prose, a path prefix
// or a truncation of one. This is also safe to use for model-only p1/p2 choices.
const displayLabel=/^[\p{L}\p{N}][\p{L}\p{N}\p{M} _+.&()（）\[\]-]{0,47}$/u;
export function autoProjectLabels(aliases) {
  const out=[];
  for (const s of aliases ?? []) {
    if (typeof s==='string' && s===s.trim() && displayLabel.test(s) && !out.some(v=>v.toLowerCase()===s.toLowerCase())) out.push(s);
    if (out.length===3) break;
  }
  return out;
}
const ignoredLatin=new Set(('a the about after again also already all and any are as at before but by can change check client code could create current data default delete design develop development different docs document documentation does error example explain feature file files first fix for form from function functions general get give has have help here how implementation implement improve in info information input interface issue issues it just latest make management module more need new next not now of on one only or order other our output page plan please previous problem process processing program project provide read record records report request result review run script server service session settings should show similar start status support system task team test testing text that the their them then there these this time title to today todo tool tools update use user users using version want was we website what when where which will with work working workspace would write you your readme changelog index main index.js').split(' '));
const genericHan='再次 一下子 一下 不太 对劲 之前 现在 目前 那个 这个 这些 那些 一个 一些 帮忙 帮我 继续 接着 还是 麻烦 如何 什么 新增 新的 需要 进行 处理 问题 相关 进一步 之前 再次 开发 实现 修复 修改 优化 更新 分析 实际 情况 统计 测试 测试用例 同步 任务 功能 项目 工作区 工作 记录 系统 管理 设计 说明 数据 平台 模块 软件 笔记 服务 代码 界面 页面 用户 报告 接口 文件 组件 文档 结果 状态 错误 布局 功能 显示 添加 检查 重写 写入 看看 默认 内容 方式 方法 信息 流程 计划 使用 工具 支持 设置 入口 详情 日志 当前 常规 需求 以及 有没有 是否 这里 一点 里面 上次 今天 上周 之前 在线 另外 直接 重新 常用 这样 可以 应该 希望 建议 尝试 上面 下面 怎么 表格 表单 按钮 部分 请求 生成 输出 新建 名称 名字 编号 的 了 把 给 和 请'.split(' ');
const weakHan=new RegExp([...new Set(genericHan)].sort((a,b)=>b.length-a.length).join('|'),'gu');

const url=/https?:\/\/[^\s"'<>「」『』（）()【】\[\]，。；、：！？]+/giu;
const fileName=/^[\p{L}\w.-]+\.(?:[cm]?[jt]sx?|md|py|go|css|json|java|rs|sql|vue|yml|yaml|html|toml|xml|csv|sh|log)$/iu;
function prose(text) {
  return workEvidence(text).visible.replace(url,' ').replace(/[\w.%+-]+@[\w.-]+\.[a-z]{2,}/giu,' ')
    .replace(/[\p{L}\p{N}_.:~%+\\/-]+/gu,p=>{
      if (!/[\\/]/u.test(p)) return p;
      const base=p.split(/[\\/]/u).at(-1);return fileName.test(base)?' '+base+' ':' ';
    });
}
function profile(text, label=false) {
  const clean=prose(text), concepts=new Map(), tokens=new Map();
  const hay=label?clean.replace(/([a-z])([A-Z])/gu,'$1 $2').replace(/[_-]/gu,' '):clean;
  for (const [domain,members] of Object.entries(vocabulary)) for (const [tag,re] of Object.entries(members)) {
    const m=re.exec(hay); if (m) concepts.set(tag,{domain,quote:m[0]});
  }
  for (const [w] of clean.matchAll(/[a-z][a-z\d]*(?:[-_.][a-z\d]+)*/giu)) {
    const k=w.toLowerCase();
    if (w.length<3 || w.length>40 || ignoredLatin.has(k) || /^(?:[a-f\d]{8,}|\w*\d{5,}|(?:user|session|request|item|task|workspace)id|errormessage|defaultvalue|fetchdata|(?:on|handle)click|getstate|(?:readme|index|main|test|config|data|package|changelog)\.[a-z]+)$/iu.test(w)) continue;
    // Accept a distinctive code object on its own, unlike a common English word.
    const object=fileName.test(w) || /[a-z][A-Z]|[a-z][0-9][a-z]|[_-]/u.test(w);
    tokens.set(k,{quote:w,object,proper:/^[A-Z][a-z]{3,}$/u.test(w)});
  }
  const runs=clean.replace(weakHan,' ').match(/[\p{Script=Han}]{4,}/gu)??[];
  return {concepts,tokens,runs};
}

// Compound label fragments do not require a pre-trained dictionary: e.g. an
// organization-specific four-Han-character instrument can match a longer label.
// Overlapping windows of ONE phrase must never be counted as independent clues.
const windows=[8,6,4];
function hanIndex(runs) {
  const out=new Set();
  for (const run of runs) for (const n of windows) for (let j=0;j<=run.length-n;j++) out.add(run.slice(j,j+n));
  return out;
}
function compound(reqIndex,runs) {
  for (const n of windows) for (const run of runs) for (let j=0;j<=run.length-n;j++) {
    const token=run.slice(j,j+n);if(reqIndex.has(token))return token;
  }
  return '';
}
const domainsOf=p=>new Set([...p.concepts.values()].map(e=>e.domain));
function match(req,idx,other,named,applicationLink) {
  const theirDomains=domainsOf(other),quotes=new Set();let credible=false;
  const exactConcepts=[...req.concepts].filter(([k])=>other.concepts.has(k));
  const shared=[...req.concepts.values()].filter(c=>theirDomains.has(c.domain));
  // A configured billing label authorizes a billing-domain inference. A stray
  // mention in a title or an accepted prompt does not confer that same weight.
  if (named && shared.length || exactConcepts.length>=2) credible=true;
  if (named || exactConcepts.length || (shared.length>=2 && other.concepts.size>=2)) {
    for (const {quote} of shared) quotes.add(quote);
    if (shared.length>=2 && [...other.concepts.values()].filter(x=>shared.some(y=>x.domain===y.domain)).length>=2) credible=true;
  }
  // Form-filling can plausibly own an actual application, not every hiring
  // question or arbitrary use of a word like “申请/投递”. Never inspect URL parts.
  if (req.concepts.has('application') && other.concepts.has('autofill') && named) {
    credible=true;quotes.add(req.concepts.get('application').quote);
  }
  if (applicationLink && (theirDomains.has('hiring') || named && other.concepts.has('autofill'))) {
    credible=true;quotes.add(applicationLink);
  }
  const han=compound(idx,other.runs);
  if (han) {quotes.add(han);if (named || han.length>=6) credible=true;}
  let exactTokens=0;
  for (const [key,t] of req.tokens) {
    const u=other.tokens.get(key);if (!u) continue;
    if (t.object || (t.proper && u.proper) || named) {quotes.add(t.quote);exactTokens++;}
    if (t.object || named) credible=true;
  }
  if (exactTokens>=2 || (exactTokens && (han || shared.length))) credible=true;
  return {credible,quotes};
}

// Delivery of physical mail/messages is not the résumé/application workflow.
// Test the object independent of word order, not only “投递”'s next word.
export const ordinaryDelivery=s=>/快递|包裹|信封|明信片|\bparcels?\b/iu.test(s) ||
  /邮件|邮箱|信件|消息|\b(?:email|message)s?\b/iu.test(s) && !/简历|网申|应聘|求职|岗位|\b(?:resume|application)\b/iu.test(s);
function applicationCue(control,visible) {
  return !ordinaryDelivery(control) && /https?:\/\//iu.test(visible) ? /(?:投递|投简历|网申|应聘|\bapply\b)/iu.exec(control)?.[0] : '';
}

/** Internal path handles; only labels/evidence, never path or source texts,
 * cross the model boundary. Every evidence string is from the visible request.
 * Multiple credible owners remain multiple: never resolve ties by recency/order. */
export function autoProjectHints(control,cat,rawRequest=control) {
  const req=profile(control),idx=hanIndex(req.runs),out=[];
  const applicationLink=applicationCue(control,workEvidence(rawRequest).visible);
  if (!idx.size && !req.concepts.size && !req.tokens.size && !applicationLink) return out;
  const rowsByCwd=new Map();
  for (const row of cat.rows) {if(!rowsByCwd.has(row.cwd)) rowsByCwd.set(row.cwd,[]);rowsByCwd.get(row.cwd).push(row);}
  for (const [path,aliases] of cat.roots) {
    const labels=autoProjectLabels(aliases),evidence=new Set();let named=false,credible=false;
    const consider=(s,isLabel,accepted=false)=>{
      if (!s) return;
      const m=match(req,idx,profile(s,isLabel),isLabel,applicationLink);
      // Two actual action+object assignments (even with different URLs) may
      // identify the same workspace, but never prove a shared session.
      if (accepted && applicationLink) {
        const visible=workEvidence(s).visible;
        if (applicationCue(visible.replace(url,' '),visible)) {m.credible=true;m.quotes.add(applicationLink);}
      }
      for (const q of m.quotes) if (q.length<=40 && control.includes(q)) evidence.add(q);
      credible ||= m.credible;named ||= isLabel && m.credible;
    };
    for (const label of labels) consider(label,true);
    for (const row of rowsByCwd.get(path)??[]) {
      consider(row.title,false);
      for (const h of row.hints) consider(h,false,true);
    }
    if (evidence.size) out.push({path,labels,evidence:[...evidence].slice(0,4),named,credible});
  }
  return out;
}
