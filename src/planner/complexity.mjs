import {maskLiterals} from './grammar.mjs';

const tierNames = {fast:'快速',standard:'标准',deep:'深度'};
const valueNames = new Map([
  ['fast','fast'],['quick','fast'],['快速','fast'],['极速','fast'],['轻量','fast'],['低','fast'],
  ['standard','standard'],['normal','standard'],['标准','standard'],['普通','standard'],['中','standard'],
  ['deep','deep'],['深度','deep'],['高','deep'],
]);
// Bare model names, adverbs, examples, and the literal words fast/standard/deep
// do not set a tier. A control needs a selector or an actual tier label.
const CJK = '快速|极速|轻量|标准|普通|深度|低|中|高';
const LAN = 'fast|quick|standard|normal|deep';
const NAME = '(' + CJK + '|' + LAN + ')';
const CJK_KIND = '(?:任务档位|模型档位|复杂度档位|档位|档次)';
const EN_KIND = '(?:model[ -]+tier|complexity[ -]+tier|routing[ -]+tier|tier|mode)';
const END = '(?![a-z0-9_/-]|\\.[a-z0-9])';
const OPTIONS = '(?:档(?:位|次)?|模式|模型档|model[ -]+tier|tier|mode)';
const directivePatterns = [
  new RegExp(CJK_KIND + '\\s*(?:[:=]|为|设为|选|用|使用|指定|选择)?\\s*' + NAME + END + '(?:\\s*' + OPTIONS + ')?', 'giu'),
  new RegExp('(?:选择|指定|使用|采用|切换到|改用|调到|选|用|走)\\s*' + NAME + '\\s*' + OPTIONS + END, 'giu'),
  new RegExp('\\b' + EN_KIND + '\\s*(?:[:=]|is\\b|to\\b|of\\b)\\s*' + NAME + END + '(?:\\s*' + OPTIONS + ')?', 'giu'),
  new RegExp('\\b(?:use|choose|select|switch\\s+to|set)\\s+(?:(?:the|a|an)\\s+)?' + NAME + '\\s+' + OPTIONS + END, 'giu'),
  new RegExp('(?:^|(?<=[，。；;!！?？\\n]))\\s*' + NAME + '\\s*' + OPTIONS + END + '(?=\\s*(?:$|[:;,，。！？]))', 'giu'),
];
const alternatives = new RegExp('^\\s*(?:(?:/|或(?:者)?|还是|二选一)\\s*|or\\b\\s+)(?:the\\s+)?' + NAME + END, 'iu');
const opposite = /(?:不(?:要|必|需要|选|用|宜)?|无需|无须|勿|别|禁止|排除|避免|\b(?:don['’]?t|do\s+not|never|avoid|without|not))\s*(?:(?:选择?|使用|采用|切换到?|改用|调到|用|走|use|choose|select|switch\s+to|set)\s*)?$/iu;
const hypothetical = /(?:如果|假如|假设|若|要是|要不要|\b(?:if|whether|suppose|should\s+(?:I|we)))\s*$/iu;
const mention = /(?:示例(?:中|里)?(?:写|是|为|有|内容)?|例句|例如|比如|举例|说明(?:中|里)|文档(?:中|里)|文案(?:中|里)?|标题(?:中|里)?|正文(?:中|里)?|字样|标签|字段|文本|引用|包含|提及|字符串|写入|翻译|字面|example|e\.g\.|such as|quote|literal|label|text|word|phrase|document|docs|say(?:s|ing)?|mention(?:s|ing)?|display|translate|field|variable|class(?:name)?|the file|means)\s*(?:(?:的|写|叫|是|把|将|有|show(?:ing)?|reads?|contains?|the|value)\s*){0,2}[:：=]?\s*$/iu;
const afterMention = /^\s*(?:(?:的|这个|一)?(?:字段|字样|字符串|标签|标题|按钮|文案|变量|一词|枚举|示例|参数|路径|文件|选项)|(?:as|in)\s+(?:(?:an?|the)\s+)?(?:example|docs?|label|title|field|literal|phrase|text)\b|\b(?:word|label|example|field|literal|phrase|button|text|variable|documentation)\b)/iu;
const exampleClause = /(?:^|[,，。;；!?！？\n])\s*(?:例如|比如|譬如|示例|例句|举例|例子|样例|for\s+example|example\b|e\.g\.|such\s+as)\s*[:：,，]?[^。;；!?！？\n]*/giu;

function nonLiteral(text) {
  // Exclude explicitly introduced examples even without quotes. Do not blank
  // ordinary tasks with a colon or project path.
  return maskLiterals(text.normalize('NFKC')).replace(exampleClause, match => match[0] + ' '.repeat(match.length - 1));
}

function explicitTiers(text) {
  const positive = new Set(), negative = new Set();
  let uncertain = false;
  for (const pattern of directivePatterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]?.toLowerCase();
      const tier = valueNames.get(value);
      if (!tier) continue;
      const before = text.slice(0, match.index).slice(-44);
      const after = text.slice(match.index + match[0].length).slice(0, 48);
      if (mention.test(before) || afterMention.test(after) || hypothetical.test(before)
        || (/[把将]\s*$/u.test(before) && /^\s*(?:改为|改成|译成|翻译|这(?:一[句行]|一段|几个字))/u.test(after))
        || (/^[低中高]$/u.test(value) && /档$/u.test(match[0]) && !/^\s*(?:$|[，。,;；:：]|来|去|做|分析|检查|修改|回答|解决|写|改)/u.test(after))) continue;
      if (opposite.test(before)) negative.add(tier);
      else {
        positive.add(tier);
        if (alternatives.test(after)) uncertain = true;
        alternatives.lastIndex = 0;
      }
    }
  }
  return {positive, negative, uncertain};
}

const splitClauses = /[.!?。；;！？，,\n:：]+/u;
const OUT_OF_SCOPE = /(?:不(?:要|必|用|需要|涉及|包含|考虑)(?:做|改|处理|重构|分析|设计)?|无须|无需|避免|排除|而非|而不是|不在范围|not\s+(?:touch(?:ing)?|includ(?:e|ing)|design(?:ing)?|chang(?:e|ing)|refactor(?:ing)?|requir(?:e|ing)|part of)|no\s+need\s+to|without|do\s+not|don['’]t|out\s+of\s+scope|rather\s+than)[^。；;!?！？\n，,]*/giu;
const SPAN = /跨(?:越|多个|两个|三[个项])?\s*(?:模块|包|服务|项目|仓库|进程|系统|应用|子系统|组件|节点|集群|分片)|(?:多|两|三|四)(?:个|套|层)?\s*(?:模块|服务|项目|仓库|系统|节点|集群|分片)(?:\s*(?:共同|协调|联动|接入|调用|改动|重构|互通|迁移))?|\b(?:cross[ -]?(?:module|package|service|project|repository|repo|process|system|component|cluster)|multi[ -]?(?:service|repo|cluster|process|region|node|tenant)|across\s+(?:(?:the|all|two|three|multiple)\s+)?(?:modules|packages|services|repositories|repos|projects|processes|subsystems)|(?:two|three|multiple|different)\s+(?:services|repos|modules|subsystems|clusters))\b/iu;
const SYSTEM = /架构|系统设计|技术架构|全链路|数据模型|分布式|协议设计|事务边界|\b(?:architectur(?:es?|al)|system design|distributed (?:system|transaction|lock|service|job)|protocol design|data model|transaction boundaries)\b/iu;
const HARD = /并发(?:一致性|控制|调度|安全|冲突|死锁|竞态|事务|幂等|重试|读写|写入|更新|边界)|竞态条件|数据竞争|死锁|读写冲突|分布式事务|事务隔离|两阶段提交|最终一致性|线性一致性|一致性协议|故障切换|共识算法|性能瓶颈|故障传播|数据丢失|幂等(?:性|重试|投递)|重放保护|\b(?:concurren(?:cy|t) (?:control|consistency|updates?|writes?|coordination|transactions?|access)|race conditions?|data races?|deadlocks?|write conflicts?|transaction isolation|(?:strong|eventual|distributed) consistency|consensus protocol|idempoten(?:cy|t (?:retries|retry|delivery|writes?))|failover|data loss|performance bottleneck|two[ -]phase commit|linearizability|failure propagation)\b/iu;
const INQUIRY = /(?:定位|排查|调查|分析|还原|复盘|追踪|诊断|查明|找出|审计|验证|排除|比较|评估|论证|证明|研究)|\b(?:diagnos\w*|investigat\w*|troubleshoot\w*|analy[sz]\w*|trac\w*|explain|audit\w*|find|identif\w*|evaluat\w*|compar\w*|prov(?:e|ing)|verify)\b/iu;
const ROOT = /根因|偶发|间歇|故障(?:链|传播)|级联(?:故障|失败)|性能退化|内存泄漏|错误传播|\b(?:root[ -]cause|intermittent|cascading failures?|regression|leaks?|non[ -]?deterministic|failure chain)\b/iu;
const CHANGE = /(?:^|[^不])(?:设计|制定|重构|迁移|实现|搭建|改造|拆分|整合|接入|升级|重写|规划|落地|上线|构建|集成|修复|修正|添加|新增|更新|覆盖)|\b(?:design\w*|redesign\w*|refactor\w*|migrat\w*|implement\w*|build\w*|rework\w*|integrat\w*|rewrite|plan\w*|fix\w*|change\w*|add\w*|updat\w*)\b/iu;
const LIMIT = /(?:只(?:改|修|有|看|查|做|修改)|仅(?:改|修|查看|修改|验证|执行)|一个(?:错别字|字|标点|句子|词|文件|按钮|链接|代码位置)|单(?:个文件|一(?:文件|地点|位置)|处|点)|一(?:处|行|句|个按钮|个链接))|\b(?:only|just|solely|single|one)\s+(?:letter|word|typo|line|file|link|line break|label|button|heading|sentence|isolated|for(?:matting)?|visual|css|specific|field|small)\b/iu;
const LIGHT = /错别字|拼写(?:错误|检查)|标点|空格|缩进|排版|格式(?:化|调整|修改|整理)?|尾随空白|续行|换行符?|字母大小写|变量名|按钮(?:文案|文字|标签)|改(?:个|一下|一处|一行|一句|一)(?:字|词|句子|标题|链接|文案)|修(?:好|正|改)?(?:一个|一处)?(?:错字|笔误|笔误字)|标题(?:文案|文字)|短文|短句|一句话|润色.{0,10}(?:一句|短句|句子|标题)|简短(?:翻译|总结|回复|说明)|翻译|译成|\b(?:typos?|misspell\w*|spelling|punctuation|whitespace|indentation|format(?:ting)?|reformat\w*|line[ -]breaks?|capitaliz\w*|proofread\w*|translat\w*|button (?:copy|label)|heading|caption|short (?:sentence|reply|paragraph)|one line|one sentence)\b/iu;
const BROAD_COPY = /长(?:文档|篇|文|报告|稿)|\b(?:long\s+(?:document|article|report)|full[ -]length)\b|(?:整[个套篇本份站库]|批量|所有|全部|全量|多语言|多篇|十[几数]?)(?:(?:份|个|处|页|篇|种|个文件|目录|文档|段落|语言|文件|文章|内容|样式|站点|仓库|字幕|项目)?)|\b(?:bulk|batch|all\s+(?:docs?|files?|pages?|strings?|modules|translations)|whole\s+(?:repo|repository|book|codebase|catalog|site)|entire|across\s+the\s+codebase|multiple\s+(?:files|documents|languages|sections)|localization pipeline|translation pipeline)\b/iu;
const DELIVERABLE = /(?:实现|开发|新增|添加|添加.{0,7}组件|接入|改造|升级|验收|回归测试|单元测试|集成测试|跑测试|补测试|验证功能|编写|配置|重构|迁移|修复|调试|排查|审查|审计|优化|设计|分析|比较|评估|报告|接口|集成)|\b(?:implement\w*|build\w*|develop\w*|add\w*|integrat\w*|configur\w*|verify|validat\w*|acceptance|regression test|tests?|test suite|api|migrat\w*|refactor\w*|fix\w*|debug\w*|audit\w*|revie\w*|review\w*|optimi[sz]\w*|design\w*|analy[sz]\w*|compar\w*|evaluat\w*|reports?)\b/iu;
const TARGETED = /(?:诊断|检查|修复|更新|替换|修改|调(?:整|大|小)|增加|更换|删除|更名|重命名).{0,14}(?:单处|这一行|这一个|一处|一个|这份|这个|同一|现有)(?:检查|文件|配置项|链接|函数|字段|文案|按钮|变量|常量|占位符|值|样式|CSS|行)|\b(?:rename|replace|update|fix|adjust|remove|change)\b.{0,42}\b(?:one|a single|the)\s+(?:field|label|link|heading|constant|button|value|filename|placeholder|line|css selector)\b/iu;
const TRANSFORM = /(?:验收|回归测试|单元测试|集成测试|接口|行为|语义|加密|数据|字段类型|并发|架构|流程|规范|投递|重构|迁移|配置|提交|部署)|\b(?:tests?|behavio[u]?r|semantic|schema|encrypt\w*|parser|api|data\s+format|protocol|deploy|integration|state machine|architecture|workflow|migrat\w*|refactor\w*)\b/iu;

const lightReason = '是目标明确的改字、格式、翻译或单点改动，规则建议快速档';
const standardReason = '是范围有界的实现、验收或检查，规则建议标准档';
const defaultReason = '信息不足以判断是明确的轻量或跨模块工作，先按标准档';
const heavyReason = '有跨模块、架构、并发约束或复杂根因等具体证据，规则建议深度档';
const evaluationAxes = [
  /成本|价格上限|预算|可负担|\b(?:cost|pricing|budget)\b/iu,
  /延迟|性能|吞吐|\b(?:latency|performance|throughput)\b/iu,
  /一致性|可用性|可靠性|抗故障|\b(?:consistency|availability|reliability|fault[- ]tolerance)\b/iu,
  /回滚|切换|迁移风险|\b(?:rollback|cutover|migration\s+risk)\b/iu,
  /数据安全|合规|攻击面|\b(?:security|privacy|compliance)\b/iu,
];

/** Interpret one subtask's routing control, never an instruction in its text. */
export function tierFor(control) {
  if (typeof control !== 'string') return {tier:'standard',reason:defaultReason};
  const text = nonLiteral(control);
  const {positive,negative,uncertain} = explicitTiers(text);
  const specified = [...positive];
  if (uncertain || specified.length > 1 || (specified.length === 1 && negative.has(specified[0]))) {
    return {tier:'standard',reason:'档位要求冲突或有备选',error:'同时出现多个档位要求，请说明这项使用哪个档位'};
  }
  if (specified.length === 1) {
    const [tier] = specified;
    return {tier,fixed:true,reason:'用户指定'+tierNames[tier]+'档'};
  }
  const working = text.replace(OUT_OF_SCOPE, ' ');
  const len = working.replace(/\s+/gu, '').length;
  const long = len > 224 || control.length > 1600;
  const change = CHANGE.test(working), inquiry = INQUIRY.test(working);
  const hard = HARD.test(working), system = SYSTEM.test(working), span = SPAN.test(working), root = ROOT.test(working);
  const actionable = change || inquiry;
  const titleEdit = /(?:起|写|取|拟|改|换|生成).{0,12}(?:个|段|一条|文章|这段话)?(?:标题|副标题)|(?:标题|副标题)(?:中|里|中原来|的内容|中的字样)?\s*.{0,35}(?:改成|改为|换成|换个|换为|替换|更正)|\b(?:draft|write|suggest|reword|rename|change)\b.{0,36}\b(?:headline|title|heading)\b/iu.test(working);
  const copyOnly = (LIGHT.test(working) || titleEdit) && !TRANSFORM.test(working) && !BROAD_COPY.test(working);
  const investigativeConstraint = working.split(splitClauses).some(clause => ROOT.test(clause) && (HARD.test(clause) || SYSTEM.test(clause) || SPAN.test(clause)));
  const competingConstraints = system && inquiry && evaluationAxes.filter(axis => axis.test(working)).length >= 2;
  if (!negative.has('deep') && !copyOnly && (
    (span && actionable) || (system && (change || (inquiry && (root || hard))))
    || (hard && actionable) || (inquiry && root && investigativeConstraint) || competingConstraints
    || (inquiry && root && /(?:涉及|比较|根据|对比).{0,14}(?:多个日志|多处日志|跨环境|上下游|多重|两类)|\b(?:correlat\w*|across (?:environments|logs|nodes)|multiple causes)\b/iu.test(working))
  )) return {tier:'deep',fixed:true,reason:heavyReason};
  if (!negative.has('fast') && !span && !BROAD_COPY.test(working) && !long && !TRANSFORM.test(working)
    && (copyOnly || TARGETED.test(working) || (LIMIT.test(working) && actionable && !root && !span && !system && !hard))) {
    return {tier:'fast',fixed:true,reason:lightReason};
  }
  if (DELIVERABLE.test(working) || BROAD_COPY.test(working) || (copyOnly && span) || long || negative.size > 0) {
    return {tier:'standard',fixed:true,reason:standardReason};
  }
  return {tier:'standard',reason:defaultReason};
}

/** A model may resolve a genuinely ambiguous small task, not invent depth. */
export function chooseTier(rule, advisedTier) {
  const fallback = Object.hasOwn(tierNames, rule?.tier) ? rule.tier : 'standard';
  if (rule?.fixed || rule?.error || advisedTier === 'deep') return fallback;
  return advisedTier === 'fast' || advisedTier === 'standard' ? advisedTier : fallback;
}
