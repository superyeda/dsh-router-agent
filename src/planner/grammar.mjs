// Parsing only produces a local control view. It must never supply the text to send.
const quotes = new Map([['“','”'],['‘','’'],['「','」'],['『','』'],['"','"'],["'","'"]]);
const ticks = String.fromCharCode(96);
const projectSelector=/(?:项目|仓库|工程|目录|工作区|路径|cwd)\s*[:：=#]?$/iu;
const sessionSelector=/(?:会话|对话|\bsessions?)(?:\s*(?:编号|id))?\s*[:：=#]?$/iu;
const sessionList=/(?:会话|对话|\bsessions?)(?:\s*(?:编号|id))?\s*[:：=#]?\s*(?:[\w:.-]+\s*(?:[、，,]|以及|和|与|及|或者?|还是|\band\b|\bor\b)\s*)+$/iu;
const destination=/(?:在|去|到|切到|进入|给|为|使用|复用|沿用)$/u;
const idFormat=/^[A-Za-z0-9][A-Za-z0-9_:.\-]{0,159}$/u;
const hide = text => text.replace(/[^\r\n]/g,' '); // one space per UTF-16 code unit

// Walk top-level literals once: a selector-looking quote nested inside a quote
// or fenced block is data, not another opportunity to restore a routing control.
function literalView(text, revealAtom, opaque) {
  let view = '', plain = 0;
  for (let i = 0; i < text.length;) {
    const start = i, c = text[i++];
    const lineStart=() => /^ {0,3}$/u.test(text.slice(text.lastIndexOf('\n',start-1)+1,start));
    if (c === '>' && lineStart()) { // Markdown quoted prose is not a routing directive, either.
      const nl=text.indexOf('\n',i);i=nl===-1?text.length:nl;
      const quote=text.slice(start,i);opaque?.push(quote);
      view+=text.slice(plain,start)+hide(quote);plain=i;continue;
    }
    let delimiter = quotes.get(c), width = 1;
    const code = c === ticks || c === '~';
    if (code) {
      while (text[i] === c) { width++; i++; }
      if (c === '~' && width < 3) continue;
      delimiter = c.repeat(width);
    } else if (!delimiter || (c === "'" && /[a-z]/iu.test(text[start-1] ?? ''))) continue;

    const content = i;
    // A Markdown block only closes on its own fence line, never at literal
    // backticks in a code sample. Treat an unclosed literal as opaque to EOF.
    const block = code && width >= 3 && lineStart();
    let end = -1;
    if (block) {
      const close = new RegExp('^ {0,3}'+c+'{'+width+',}[ \\t]*\\r?$','gmu');
      close.lastIndex = i;
      const match = close.exec(text);
      if (match) end = match.index + match[0].length;
    } else {
      let at = text.indexOf(delimiter,i);
      while (!code && at !== -1) {
        let before = at; while (text[before-1] === '\\') before--;
        if ((at-before)%2 === 0) break;
        at = text.indexOf(delimiter,at+1);
      }
      if (at !== -1) end = at + delimiter.length;
    }
    i = end === -1 ? text.length : end;
    view += text.slice(plain,start);
    const atom = text.slice(content,i-delimiter.length);
    if (revealAtom && end !== -1 && !(code && width >= 3) && revealAtom(text,start,i,atom,view)) {
      view += ' '.repeat(width) + atom + ' '.repeat(delimiter.length);
    } else {
      const quote=text.slice(start,i);opaque?.push(quote);view+=hide(quote);
    }
    plain = i;
  }
  return view + text.slice(plain);
}

// A URL is a work object, never a cwd, session or tier selector in its own
// right (e.g. ?project=Atlas&tier=deep). Identity/evidence uses the raw URL.
const withoutUrls = text => text.replace(/https?:\/\/[^\s"'<>「」『』（）()【】\[\]，。；、：！？]+/giu, url=>' '.repeat(url.length));
export const maskLiterals = text => withoutUrls(literalView(text));
export function routingControl(text, knownProject) {
  const quotedIds=new Set();let error, lastProjectEnd=-1;
  const join=/(?:[、，,]|以及|和|与|及|或者?|还是|\band\b|\bor\b)\s*$/iu;
  const control=literalView(withoutUrls(text),(s,start,end,atom,visibleLeft)=>{
    const left=s.slice(0,start).trimEnd(), right=s.slice(end).trimStart();
    if (sessionSelector.test(left) || sessionList.test(visibleLeft.trimEnd()) || (destination.test(left) && /^(?:会话|对话)/u.test(right))) {
      if (!idFormat.test(atom)) {error='引用的会话不是单个完整的 ID；请明确唯一的目标会话';return false;}
      quotedIds.add(atom);return true;
    }
    const separator=join.exec(visibleLeft);
    const before=separator && visibleLeft.slice(0,separator.index).trimEnd().replace(/(?:项目|仓库|工程|目录)$/u,'').trimEnd();
    const afterSelector=before?.split(/(?:在|给|为|到|去|使用|进入|项目|目录)\s*/u).at(-1);
    const joined=separator && ((lastProjectEnd>=0 && !s.slice(lastProjectEnd,start).replace(join,'').trim()) || knownProject?.(afterSelector));
    if (joined || projectSelector.test(left) || /^(?:项目|仓库|工程|目录|工作区|路径)/u.test(right)) {
      // Never re-interpret a quoted instruction (e.g. 项目“在 A 和 B 工作”)
      // as if its own words had selected one of the authorized directories.
      if (knownProject && !knownProject(atom)) {error='引用的项目或目录未能精确对应到已选目录；请明确唯一目标';return false;}
      lastProjectEnd=end;return true;
    }
    if (destination.test(left) && (knownProject?.(atom) || /^(?:[a-z0-9_.-]+|(?:[A-Z]:[\\/]|[/.~\\])[^,，。；;\r\n]*)$/iu.test(atom))) {
      lastProjectEnd=end;return true;
    }
    return false;
  });
  return {control,quotedIds,error};
}
export const routeText = text => routingControl(text).control;

// These are *positive reuse/hold signals*, never a vocabulary that a new task
// must match. An ordinary utterance, whatever its verbs/language, can be new.
const destinationNoun='(?:工作区|目录|项目|仓库|会话|对话|路由|目标|目的地)';
const choose='(?:选(?:择|定)?|决定|确认|指定|挑)';
const me='(?:(?:先|要|等|让|由|需要)我|我(?:想要?|需要|得|要|来|先))(?:先|来|自己|手动|亲自)?';
const confirmRoute=[
  new RegExp(me+choose+'(?:一下)?(?:.{0,8}'+destinationNoun+'|.{0,6}(?:再|后|才能)(?:发|投递|分流)|[，。！!？?]|$)','u'),
  new RegExp(destinationNoun+'.{0,10}(?:让我|等我|我来|由我|先和我|先跟我)(?:自己|手动)?'+choose,'u'),
  /(?:先问我|先询问我|先征求我的(?:意见|同意)|等我确认)(?:.{0,10}(?:再|后)(?:选|发|定|开始)|[，。；！!？?]|$)/u,
  /(?:不要|别|不能)(?:再|替我|帮我|擅自)*自动.{0,3}(?:选|定|投递|发)|(?:先别|先不要)(?:发送|投递|分发)|(?:先确认|确认一下|确认后)(?:一下)?(?:后|好了)?再(?:发送|投递|发出|发[，。！!？?]|发$)/u,
  /\b(?:ask me (?:first|before)|let me (?:choose|pick|confirm) (?:the |a )?(?:workspace|project|session|target))\b/iu,
];
const unclearChoice=[
  new RegExp('(?:哪个|哪一个|哪条|哪份)'+destinationNoun+'|'+destinationNoun+'.{0,6}(?:选哪|哪个|哪一个)','u'),
  /(?:新开|新建|沿用|复用|续接).{0,10}(?:还是|或(?:者)?).{0,10}(?:新开|新建|沿用|复用|续接|接着|继续)/u,
  /(?:选|用|去|发到|放到)(?:第[一二三四五六七八九十0-9]+个|前者|后者)(?:项目|会话|目录|工作区|[，。；!？?]|$)/u,
];
export function routingHold(control) {
  const affirmed=control.replace(/(?:不用|无需|不需要|不必)(?:再)?(?:让|等|由)?我(?:来|自己|手动)?(?:选择|确认|指定)/gu,' ');
  if(confirmRoute.some(r=>r.test(affirmed))) return '你要求先确认目标；这条消息不会自动投递';
  if(unclearChoice.some(r=>r.test(control))) return '有未确定的备选目标；请先明确要做哪一个';
}

// A bound expression consisting only of a pointer and/or an edit to the last
// answer can use local admission as its missing object. Do not extend that
// inference to arbitrary short text, or erase a URL/quote/code block to make
// the rest of the request look like a bare pointer.
const pointer='(?:(?:刚才|刚刚|刚|上次|上回|之前|前面|上面|原来)(?:说)?(?:的)?(?:[这那上]一?|一)?(?:个|份|条|件事|段|篇|项|步|版(?:本)?|内容|工作|任务|事情|问题|说明|实现|方案|回答|回复|会话|对话|稿子)?|[这那上](?:一)?(?:版|段|份|个|条)(?:内容|回答|草稿)?)';
const transform='(?:短|长|简短|简洁|精简|详细|正式|口语化|具体|清楚|直白|展开|细化|缩短|压缩|扩写|扩展|具体说明|调整语气)(?:一?(?:点|些)|一点儿|一些|一下)?';
const alternative='(?:换(?:一)?个(?:说法|角度|表达|版本)|(?:给|来|出|写)(?:我)?(?:一|另(?:外)?一|个|新)?(?:个)?(?:版|版本)|(?:改成|改为|换成|整理成|用)(?:一?[份个张种])?(?:表格|列表|要点|提纲|白话|英文|中文)(?:形式|表达)?|说(?:得)?(?:具体|详细|清楚)点)';
const editLast=new RegExp('^(?:(?:请(?:你)?|麻烦(?:你)?|可以|能不能|帮我|给我|能|那就|那么)|把|将)*(?:'+pointer+')?(?:请|再|稍微|更|能不能|能|帮我)*(?:'+transform+'|'+alternative+')(?:吗|呢|吧|好吗|就好)?$','u');
const barePointer=new RegExp('^(?:(?:请(?:你)?|麻烦(?:你)?|帮我|好(?:的)?|那就|那么)|咱们|我们)*(?:(?:继续|接着|接下去|往下|接续|跟进|接上|沿用|复用)(?:'+pointer+')?(?:说|做|写|来|讲|处理|看|分析|聊|往下说)?|'+pointer+'|接下来|然后|下一步|后来)(?:怎样|怎么样|如何|呢|吗|吧|呀|啊|了)?$','u');
export function continuation(control, raw, places=[]) {
  const normalized=control.trim().normalize('NFKC');
  // Strip an *already resolved* addressing prefix, not objects inside the task.
  let subject=normalized;
  for(const place of [...places].sort((a,b)=>b.length-a.length)) {
    const escaped=place.replace(/[.*+?^$(){}|[\]\\]/g,'\\$&');
    subject=subject.replace(new RegExp('^(?:请)?(?:在|到|去|给|为)?\\s*(?:项目|目录|工作区)?\\s*'+escaped+'\\s*(?:项目|仓库|工程|目录|工作区)?[，,：:\\s]*','iu'),'');
  }
  subject=subject.replace(/^(?:在|到|给)?(?:这个|当前|本|该)(?:项目|工作区|仓库|目录)[，,：:\s]*/u,'');
  if(places.length) subject=subject.replace(/^(?:使用|在|给|到)(?:已选的?|设置的?)?(?:通用(?:目录|工作区)|默认(?:的)?(?:项目|工作区|目录))[，,：:\s]*/u,'');
  const compact=subject.replace(/[\s，,。.!！?？：:；;、～~…]/gu,'');
  const previous=/(?:别管|忽略|不管|不是|不要继续|不接着|不(?:再)?跟进)(?:刚才|上次|那个|上一|之前)|另一(?:件事|个问题|项工作|个需求)|换(?:个|一个)话题|全新(?:的)?(?:任务|问题)/u.test(normalized);
  const literal=workEvidence(raw).opaque.length>0 || /https?:\/\//iu.test(raw);
  const pure=compact.length<=64 && !previous && !literal && (barePointer.test(compact) || editLast.test(compact) || /^(?:please )?(?:continue|go on|keep going|what next|make it (?:shorter|longer)|rephrase (?:it|that))[.!? ]*$/iu.test(subject));
  const follow=pure || /(?:^|[，,。；;：:\s]|请|帮我|项目)(?:继续|接着(?:做|改|查|修|写|说|处理)|接上|接续)|跟进|(?:沿用|复用|回到)(?:(?:上次|之前|原来|已有|现有|刚才|那个|当前|原|旧|的)\s*)*(?:会话|对话)|(?:刚才|刚刚|上次|上回|之前)(?:提到|提过|说过|没做完|的(?:那|事|任务|工作|会话)|那(?:版|份|个)|这一版)|(?:进展(?:如何|怎样)|(?:修|做|查|写)(?:完|好)了吗)|\b(?:continue|follow up on|pick up where)\b/iu.test(subject);
  return {pure,follow:!previous && follow,previousExcluded:previous};
}
// File names, ticket IDs and individual links are concrete work objects even
// in inline code. An instruction inside a quote or a whole code block is not.
const identifier = (_text,_start,_end,atom) => /^(?:https?:\/\/[^\s]+|[a-z0-9_.:/#\\-]+)$/iu.test(atom);
export function workEvidence(text) {
  const opaque=[];return {visible:literalView(text,identifier,opaque),opaque};
}

// Resolve every explicit address in the control view, not just the first valid
// one. A joined ID, unknown ID or malformed second selector must not authorize
// delivering the entire message to the first session.
export function sessionTargets(control,quotedIds) {
  const refs=new Set(quotedIds); let malformed=false;
  const markers=/(?:会话|对话|\bsessions?(?:id)?\b)(?:\s*(?:编号|id\b))?\s*[:：=#]?\s*/giu;
  const token=/^[A-Za-z0-9_~./\\-][A-Za-z0-9_:./~%?&#@=+\\-]*/u;
  const join=/^\s*(?:[、，,]|以及|和|与|及|或者?|还是|\band\b|\bor\b)\s*/iu;
  for (const marker of control.matchAll(markers)) {
    // “另开会话：docs/install.md …” introduces the message body, not an ID.
    if (/[：:]\s*$/u.test(marker[0]) && /(?:另[开起建]|新[开建起]|创建)(?:一[个条])?(?:新的?)?$/u.test(control.slice(0,marker.index))) continue;
    const before=control.slice(0,marker.index);
    let tail=control.slice(marker.index+marker[0].length);
    // A written ID selector needs an actual valid ID. A name standing in that
    // slot is not authority to fall through to the latest local conversation.
    if(!token.test(tail) && (/(?:\bid\b|编号|[:=#：])/iu.test(marker[0]) || /(?:发到|投递到|发往|打开|回到)\s*$/u.test(before) && /^[\p{L}\p{N}]/u.test(tail))) malformed=true;
    while (true) {
      const id=token.exec(tail)?.[0];
      if (!id) break;
      if (idFormat.test(id)) refs.add(id);
      else malformed=true;
      tail=tail.slice(id.length);
      const sep=join.exec(tail);
      if (!sep) break;
      tail=tail.slice(sep[0].length);
      if (/^(?:会话|对话|sessions?(?:id)?\b)/iu.test(tail)) break; // next marker handles it
      if(!token.test(tail) && !/^[、，,]/u.test(sep[0].trimStart())) malformed=true;
    }
  }
  const multiple=/(?:分别|各自)(?:另开|新建|新开|使用|创建|开)(?:一个|一条)?(?:新|单独的)?(?:会话|对话)|(?:创建|新开|建立|新建|另开|分成|分到|使用|发到|投递到|开|在)\s*(?:[两二三四五六七八九十百千万][一二三四五六七八九十百千万]*|[多几]|[2-9]|[1-9]\d+|不同的?)\s*个?\s*(?:会话|对话)|\b(?:open|create|use|send to)\s+(?:two|three|multiple|different|separate|[2-9]|[1-9]\d+)\s+sessions?\b/iu.test(control);
  const opens=[...control.matchAll(/(?:另[开起建]|新[开建起]|单独[开建]|创建)(?:一[个条])?(?:新的?)?(?:会话|对话|聊天)/gu)];
  const another=opens.some((m,i)=>i>0 && /[;；。\r\n]|另(?:外|一)|分别|再|同时|然后/u.test(control.slice(opens[i-1].index+opens[i-1][0].length,m.index)));
  return {refs:[...refs],malformed,multiple:multiple || another};
}
