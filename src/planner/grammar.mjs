// Parsing only produces a local control view. It must never supply the text to send.
const quotes = new Map([['“','”'],['‘','’'],['「','」'],['『','』'],['"','"'],["'","'"]]);
const ticks = String.fromCharCode(96);
const projectSelector=/(?:项目|仓库|工程|目录|路径|cwd)\s*[:：=#]?$/iu;
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
    if (joined || projectSelector.test(left) || /^(?:项目|仓库|工程|目录|路径)/u.test(right)) {
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
    let tail=control.slice(marker.index+marker[0].length);
    while (true) {
      const id=token.exec(tail)?.[0];
      if (!id) break;
      if (idFormat.test(id)) refs.add(id);
      else malformed=true;
      tail=tail.slice(id.length);
      const sep=join.exec(tail);
      if (!sep) break;
      tail=tail.slice(sep[0].length);
      if (/^sessions?(?:id)?\b/iu.test(tail)) break; // next marker handles it
    }
  }
  const multiple=/(?:分别|各自)(?:另开|新建|新开|使用|创建|开)(?:一个|一条)?(?:新|单独的)?(?:会话|对话)|(?:创建|新开|建立|新建|另开|分成|分到|使用|发到|投递到|开|在)\s*(?:[两二三四五六七八九十百千万][一二三四五六七八九十百千万]*|[多几]|[2-9]|[1-9]\d+|不同的?)\s*个?\s*(?:会话|对话)|\b(?:open|create|use|send to)\s+(?:two|three|multiple|different|separate|[2-9]|[1-9]\d+)\s+sessions?\b/iu.test(control);
  const opens=[...control.matchAll(/(?:另[开起建]|新[开建起]|单独[开建]|创建)(?:一[个条])?(?:新的?)?(?:会话|对话|聊天)/gu)];
  const another=opens.some((m,i)=>i>0 && /[;；。\r\n]|另(?:外|一)|分别|再|同时|然后/u.test(control.slice(opens[i-1].index+opens[i-1][0].length,m.index)));
  return {refs:[...refs],malformed,multiple:multiple || another};
}
