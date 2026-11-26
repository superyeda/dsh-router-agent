// Local grammar owns task text, keys and edges. No model may rewrite them.
const NUM = '[一二两三四五六七八九十百零〇0-9]+';
const ORD = '(?:' + NUM + '|[A-Z](?![A-Za-z]))';
const UNIT = '(?:个?(?:子任务|任务|步骤|事项|分项)|[项步条件个])';
const LABEL = new RegExp('^(?:(?:任务|步骤|事项|分项|第)\\s*(' + ORD + ')\\s*' + UNIT + '?|[（(]?(' + ORD + ')[）)]?)\\s*[.．、:：）)]', 'u');
const ACTION = /^(?:请|帮我|给我|麻烦|想要?|需要|要|去|为|给|在|把|将|对|用|按|写|撰写|起草|制作|做|编[写制]|改|修|实现|开发|新增|添加|创建|新建|实现|搭建|设计|优[化先]|重构|迁移|分析|排查|调查|解决|检查|审查|整理|研究|梳理|总结|翻译|解释|生成|测试|补|验证|发布|部署|运行|制作|继续|回答|比较|对比|列|统计|处理|跟进|查看|画|建|出|把)/u;
const NEXT = /^(?:然后|接着|随后|最后|下一步|而后|再(?!次|现)|等(?:待)?(?:上|前|第|任务)|(?:根据|基于|用)(?:上一步|前一项|第.{1,4}[项步]))/u;
const OTHER = /^(?:另外|此外|同时|还有|另请|顺便|独立地?|再单独|还想|还要|也请|并且|以及|一并)/u;
const OPEN = new Map([['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['"', '"'], ["'", "'"]]);

// Keep UTF-16 offsets identical for slicing the *original* text (including emoji).
// In routing controls, keep standalone quoted identifiers/paths (在“商城”项目),
// not a quoted instruction/example inside the requested deliverable.
export function routeText(text) {
  const quoted = maskLiterals(text), out = quoted.split('');
  const atom = /([“「『"'\x60])([^“”「」『』"'\x60\n]{1,160})([”」』"'\x60])/gu;
  for (const m of text.matchAll(atom)) {
    if (quoted.slice(m.index,m.index+m[0].length).trim() || /[,，。；;]/u.test(m[2])) continue;
    const left=quoted.slice(0,m.index).trimEnd(), right=quoted.slice(m.index+m[0].length).trimStart();
    const selector = /(?:项目|仓库|工程|目录|路径|会话|对话|cwd)[:：=#]?$/iu.test(left) || /^(?:项目|仓库|工程|目录|路径|会话|对话)/u.test(right);
    const directional = /(?:在|去|到|切到|进入|给|为|使用)$/u.test(left) && /^[\w./\\:@~ -]+$/u.test(m[2]);
    if (selector || directional) for (let i=0;i<m[2].length;i++) out[m.index+1+i]=m[2][i];
  }
  return out.join('');
}

export function maskLiterals(s, brackets = false) {
  const out = s.split('');
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i], top = stack.at(-1);
    if (top?.literal) {
      out[i] = ' ';
      if (s.startsWith(top.end, i) && s[i - 1] !== '\\') {
        for (let j = 1; j < top.end.length; j++) out[++i] = ' ';
        stack.pop();
      }
    } else if (c === String.fromCharCode(96)) {
      let n = 1;
      while (s[i + n] === c) n++;
      stack.push({ end: c.repeat(n), literal: true });
      for (let j = 0; j < n; j++) out[i + j] = ' ';
      i += n - 1;
    } else if (OPEN.has(c) && !(c === "'" && /[a-z]/i.test(s[i - 1] ?? ''))) {
      stack.push({ end: OPEN.get(c), literal: true }); out[i] = ' ';
    } else if (brackets && /[(（【[]/u.test(c)) {
      stack.push({ end: ({ '(': ')', '（': '）', '【': '】', '[': ']' })[c] }); out[i] = ' ';
    } else if (top) {
      out[i] = ' ';
      if (c === top.end) stack.pop();
    }
  }
  return out.join('');
}

function numberOf(s) {
  if (/^\d+$/.test(s)) return Number(s);
  const digits = '零一二三四五六七八九';
  const t = s.replaceAll('两', '二').replaceAll('〇', '零');
  if (/^[一二三四五六七八九]?十[一二三四五六七八九]?$/.test(t)) {
    const [a, b] = t.split('十'); return (a ? digits.indexOf(a) : 1) * 10 + (b ? digits.indexOf(b) : 0);
  }
  return t.length === 1 && digits.includes(t) ? digits.indexOf(t) : NaN;
}
function labelKey(s) { return /^[A-Z]$/.test(s) ? s : String(numberOf(s)); }
const headingOf = s => s.trim().replace(/^[-*•]\s*/u, '');
function partsOf(text) {
  const view = maskLiterals(text, true);
  const cuts = new Set([0]); let lastCut=0;
  for (const m of view.matchAll(/[\r\n；;。，,]+/gu)) {
    const end = m.index + m[0].length;
    const right = view.slice(end).trimStart();
    const original = text.slice(end).trimStart();
    if (!right || !original) continue;
    const isList = LABEL.test(headingOf(original)) || /^[-*•]\s/u.test(original);
    const strongBreak = /[\r\n；;。]/u.test(m[0]);
    const lhs=view.slice(lastCut,m.index);
    const prefaced=/^(?:等(?:待|到)?|待|在)?(?:第.{1,20}[项步]|任务.{1,16}|前.{1,8}[项步]|上一步|上一项|.{1,16}审批)(?:都|全部)?(?:完成|通过|结束)(?:以|之)?后$/u.test(lhs.trim().replace(LABEL,'').trim());
    const temporal=/^(?:等(?:到|待)?|待)?(?:(?:第|任务|步骤|前)[一二两三四五六七八九十0-9]{1,3}[项步个]?|上一步|上一项|[^，；]{1,12}审批)?(?:成功|完成|结束|通过)(?:以|之)?后/u.test(right);
    if (!prefaced && (temporal || isList || /[；;]/u.test(m[0]) || NEXT.test(right) || OTHER.test(right) || (strongBreak && ACTION.test(right)) || /^(?:在|给|为|对).{1,25}项目/u.test(right) || (ACTION.test(right) && /(?:请|帮|写|改|修|创建|生成|翻译|解释|起草|整理|制作|实现|添加|分析|完成|处理)/u.test(lhs)))) {cuts.add(end); lastCut=end;}
  }
  // Unpunctuated coordination needs an actual second predicate. A noun list or
  // “可以同时支持…” is not, by itself, another task.
  for (const m of view.matchAll(/另外(?:还要|还想)?|还想|还要|另请|顺便|然后|接着|随后|再(?!次|现)/gu)) {
    if (!m.index || !ACTION.test(view.slice(m.index + m[0].length).trimStart())) continue;
    const left = view.slice(0, m.index).trimEnd();
    if (!left || /[，,；;。\n]$/u.test(left) || (m[0] === '再' && !/先[^，；。\n]*$/u.test(left))) continue;
    cuts.add(m.index);
  }
  cuts.add(text.length);
  const points = [...cuts].sort((a,b) => a-b);
  const out = [];
  for (let i = 1; i < points.length; i++) {
    const s = text.slice(points[i-1], points[i]).replace(/[，,；;。\s]+$/u, '').trim();
    if (s) out.push(s);
  }
  // A header announces the following list; never schedule it as an empty job.
  if (out.length > 1 && /[:：]$/u.test(out[0]) && out[0].length < 100) out.splice(0, 2, out[0] + '\n' + out[1]);
  return out;
}

const TARGET = new RegExp('^(?:((?:上|前)一[步项条个]|上一(?:个)?任务|刚才那项|前面(?:所有|全部)(?:任务|步骤)|前(?:面)?(?:各|所有|全部)[项步]|以上(?:所有|全部)?(?:任务|步骤))|前(' + NUM + ')[项步个]|t([0-9]+)|(?:第|任务|步骤|分项)?\\s*(' + ORD + ')\\s*' + UNIT + '?)', 'u');
function graph(parts) {
  const labels = new Map();
  for (let i = 0; i < parts.length; i++) {
    const h = LABEL.exec(headingOf(parts[i]).replace(/^.{0,100}[:：]\n/u, ''));
    if (h) {
      const key = labelKey(h[1] ?? h[2]);
      if (labels.has(key)) throw Error('编号「' + key + '」重复，无法确定依赖指向');
      labels.set(key, i);
    }
  }
  const edges = parts.map(() => new Set());
  for (let i = 0; i < parts.length; i++) {
    const s = maskLiterals(parts[i]).replace(/(?:不|无[须需]|不用|不必)(?:需要)?(?:依赖|等待)(?:于)?[^，；。)）\n]*/gu, '');
    const add = (index, phrase) => {
      if (index == null || index < 0 || index >= parts.length) throw Error('「' + phrase + '」没有可引用的本次任务');
      edges[i].add(index);
    };
    const useTargets = (str) => {
      let rest = str.trimStart(), first = true;
      while (rest) {
        const m = TARGET.exec(rest);
        if (!m) throw Error('无法确认依赖「' + rest.slice(0, 28) + '」，请用本次任务的编号说明');
        if (m[1]) {
          if (/所有|全部|各|以上/u.test(m[1])) { if (!i) add(-1, m[0]); for (let j=0;j<i;j++) add(j,m[0]); }
          else add(i-1, m[0]);
        } else if (m[2]) {
          const n = numberOf(m[2]);
          if (!Number.isInteger(n) || n < 1 || n > i) throw Error('「' + m[0] + '」超出已列出的前置项');
          for (let j=0;j<n;j++) add(j, m[0]);
        } else if (m[3]) add(Number(m[3])-1, m[0]);
        else { const key=labelKey(m[4]); add(labels.size ? labels.get(key) : numberOf(m[4])-1, m[0]); }
        first = false;
        rest = rest.slice(m[0].length).trimStart();
        if (/^(?:或者?|还是|任选|其一|二选一)|^[-~～至到]\s*(?:第|任务|步骤|t\d|\d)/u.test(rest)) throw Error('依赖包含备选或范围；请明确列出所有必须成功的前置项');
        const join = /^(?:、|和|以及|及|与|&|[,，](?=\s*(?:第|任务|步骤|t\d|[A-Z](?![A-Za-z])|\d)))/u.exec(rest);
        if (!join) break;
        rest = rest.slice(join[0].length).trimStart();
        if (!rest) throw Error('依赖列表不完整');
      }
      if (first) throw Error('没有给出可确认的依赖项');
    };
    // 前一步 is implicit only where the user actually asked for a sequence.
    const same = headingOf(s).replace(LABEL, '').trimStart();
    if (/^(?:然后|接着|随后|最后|下一步|而后|再(?!次|现))/u.test(same) && i) add(i-1, '上一步');
    const depCue = /(?:依赖于?|取决于|基于|根据|使用|等待|等到|待|等)\s*[:：]?\s*/gu;
    for (const m of s.matchAll(depCue)) {
      const tail = s.slice(m.index + m[0].length);
      if (TARGET.test(tail.trimStart())) useTargets(tail);
      else if ((/依赖|取决于/u.test(m[0]) && !/(?:安装|更新|升级|项目|第三方|软件|包|管理|锁定|外部库)(?:的)?$/u.test(s.slice(0, m.index)) && !/^(?:注入|包|库|树|版本|冲突|安装|关系图|管理|分析)/u.test(tail)) || (/^等|^待/u.test(m[0]) && /^[^，。；]{1,32}(?:完成|结束|通过|批准)后/u.test(tail))) {
        throw Error('无法把「' + (m[0]+tail).slice(0, 30) + '」对应到本次任务；请明确前置项');
      }
    }
    for (const m of s.matchAll(new RegExp('((?:(?:第|任务|步骤|前)' + ORD + UNIT + '?|上一步|上一项)(?:\\s*(?:和|及|、|与)\\s*(?:(?:第|任务|步骤)?' + ORD + UNIT + '?))*)\\s*(?:都|均|全部)?(?:完成|成功|结束|通过)(?:以|之)?后', 'gu'))) useTargets(m[1]);
    if (/(?:根据|基于|使用|用|拿|参考|接着)(?:其|它的|上一步的?|前一项的?)(?:结果|输出|产物|报告|结论)/u.test(s)) add(i-1, '上一步的结果');
    if (/(?:等它|等其|等这个任务|等前者)(?:完成|结束|成功)后/u.test(s)) add(i-1, '前一项');
    if (/^(?:完成|通过|结束)(?:以|之)?后/u.test(same) || /[（(，,]\s*(?:等)?(?:它|其)?(?:完成|结束)(?:以|之)?后/u.test(s)) add(i-1, '完成后');
    if (!edges[i].size && /(?:上|前)一(?:步|项|个任务)(?:的)?(?:输出|结果|产物|报告|结论|完成)|前者(?:的)?(?:输出|结果)|(?:它|其)(?:的)?(?:输出|结果)/u.test(s)) add(i-1,'前一项的结果');
    if (/^(?:等|待|在)?[^，；。\n]{1,36}(?:审批|审核|任务|步骤|上线|部署)(?:通过|完成|结束)(?:以|之)?后/u.test(same) && !edges[i].size) throw Error('存在未对应到本次编号的前置条件，请明确依赖后再执行');
    if (/\b(?:depends?\s+on|dependsOn|requires)\s*[:=]?\s*/iu.test(s)) {
      for (const m of s.matchAll(/\b(?:depends?\s+on|dependsOn|requires)\s*[:=]?\s*/giu)) useTargets(s.slice(m.index+m[0].length));
    }
  }
  const visited = new Set(), stack = [];
  function visit(i) {
    if (stack.includes(i)) throw Error('依赖成环：' + [...stack.slice(stack.indexOf(i)),i].map(j=>'t'+(j+1)).join(' → '));
    if (visited.has(i)) return;
    stack.push(i); for (const b of edges[i]) visit(b); stack.pop(); visited.add(i);
  }
  parts.forEach((_,i) => visit(i));
  return parts.map((text,i) => ({key:'t'+(i+1), text, dependsOn:[...edges[i]].sort((a,b)=>a-b).map(j=>'t'+(j+1))}));
}
export function decompose(text, limit) {
  const parts = partsOf(text);
  if (!parts.length) throw Error('没有可识别的任务内容');
  if (parts.length > limit) throw Error('一次最多确认 ' + limit + ' 项；本次共 ' + parts.length + ' 项，请分批提交');
  return graph(parts);
}
