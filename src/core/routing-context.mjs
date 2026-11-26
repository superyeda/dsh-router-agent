// The journal contributes user work descriptions and local ordering, never Session
// authority. Only adapter.listSessions supplies the live IDs and actual directories.
const cap={tasks:192,items:768,sessions:128,hints:6,chars:4096,totalChars:65536};
const token=s=>typeof s==='string' && s.length>0 && s.length<=160 && !/[\u0000-\u001f]/u.test(s);
const positive=n=>Number.isSafeInteger(n) && n>0;
const receipt=i=>i?.accepted===true && i.attempted===true && ['create','reuse'].includes(i.decision) &&
  token(i.sessionId) && token(i.requestId) && Number.isSafeInteger(i.afterSeq) && i.afterSeq>=-1;
const sentOriginal=i=>typeof i.text==='string' && !!i.text.trim() && (i.payload===i.text ||
  (i.approved===true && typeof i.payload==='string' && i.payload.startsWith(i.text+'\n\n')));
const itemsOf=t=>Array.isArray(t?.items)?t.items:[];
const binding=i=>({id:i.sessionId,cwd:i.project,requestId:i.requestId,afterSeq:i.afterSeq});

// Reserve order in the same Web Lock + durable write as the *first* admission
// attempt. An ordinal is NOT a receipt. If the reply is lost, observing its real
// rpcId may later prove it, without today's tick or a retry making older work new.
export function reserveRouteOrder(doc,item,now,batch) {
  if(item.attempted) return;
  // One legacy parallel wave is one user action. Its network scheduling order
  // cannot select a "last conversation" among several successful destinations.
  if(batch && positive(batch.order)) {item.routeOrder=batch.order;return;}
  const floor=doc.routeClock??0, order=Math.max(floor+1,positive(now)?now:1);
  if(!Number.isSafeInteger(floor) || floor<0 || !positive(order)) {doc.routeClock=null;return;}
  doc.routeClock=item.routeOrder=order;
  if(batch) batch.order=order;
}

function latestReceipt(tasks,allowed,clock) {
  const legacy=clock===undefined;
  if(!legacy && !positive(clock)) return null; // includes an explicit cleanup barrier
  let last=null;
  // Inspect local receipt headers BEFORE narrowing by project, roster or hint
  // budget. A recent follow-up may be on the oldest task. Never pick the next
  // visible row because the actual head was lost, moved, revoked or archived.
  for(const task of tasks) for(const i of itemsOf(task)) {
    if(!i || (!i.attempted && !i.accepted)) continue;
    if(!legacy && positive(i.routeOrder) && i.routeOrder>clock) return null; // inconsistent journal watermark
    if(!legacy && i.routeOrder!==clock) continue;
    // v0.2.0 has no admission order; createdAt belongs to a whole task (which
    // can even be followed up much later). All receipts must agree on ONE target.
    if(last && (!legacy || last.sessionId!==i.sessionId || last.project!==i.project)) return null;
    if(!allowed.has(i.project) || !receipt(i) || (legacy && i.routeOrder!==undefined)) return null;
    if(!sentOriginal(i) && !(i.approved===true && typeof i.payload==='string' && i.payload.trim() && i.payload===i.handoff)) return null;
    // All unnumbered receipts that survived the checks identify the same
    // session: its native cursor can select a binding hint, never another ID.
    if(!last || i.afterSeq>last.afterSeq) last=i;
  }
  return last;
}

export function acceptedWork(tasks,allowed,clock) {
  const last=latestReceipt(tasks,allowed,clock);
  const index=new Map(); let visited=0,chars=0;
  function add(i) {
    const group={cwd:i.project,hints:[],binding:binding(i)};index.set(i.sessionId,group);return group;
  }
  function addHint(g,i) {
    // Do not learn from a truncated prefix, replacement handoff, assistant
    // result or transcript. Only the admitted user-authored original qualifies.
    if(!sentOriginal(i)) return;
    const hint=i.text.trim();
    if(hint.length<=cap.chars && chars+hint.length<=cap.totalChars && g.hints.length<cap.hints && !g.hints.includes(hint)) {
      g.hints.push(hint);chars+=hint.length;
    }
  }
  // Prioritize the genuine last receipt also for an in-flight/blank candidate's
  // native verification, even if that follow-up lives outside the hint window.
  if(last) addHint(add(last),last);
  for(const task of tasks.slice(0,cap.tasks)) {
    const items=itemsOf(task);
    for(let n=items.length-1;n>=0 && visited<cap.items;n--,visited++) {
      const i=items[n];
      if(!receipt(i) || !allowed.has(i.project)) continue;
      const g=index.get(i.sessionId)??(index.size<cap.sessions?add(i):null);
      if(g && g.cwd===i.project) addHint(g,i);
    }
    if(visited>=cap.items) break;
  }
  // Conflicting local bindings must not disappear behind an allowlist or hint
  // cap. Inspect only local identity metadata here, never a revoked payload.
  for(const t of tasks) for(const i of itemsOf(t)) {
    if(!i?.attempted && !i?.accepted) continue;
    const g=index.get(i.sessionId);
    if(g && g.cwd!==i.project) g.conflict=true;
    if(last && i.requestId===last.requestId && i.sessionId!==last.sessionId) index.get(last.sessionId).conflict=true;
  }
  return {bindings:[...index.values()].filter(g=>!g.conflict).map(g=>g.binding),
    forPlan(rows) {
      const uniqueHead=last && rows.filter(r=>r.id===last.sessionId).length===1;
      return rows.map(({lastRoutedAt:_ignore,...row})=>{
        const g=index.get(row.id), exact=g && !g.conflict && g.cwd===row.cwd;
        const head=uniqueHead && exact && row.id===last.sessionId;
        // Expose only the globally latest verified row, never a lower rank
        // that could be promoted by a subsequent candidate/project filter.
        return {...row,workHints:exact?g.hints.slice().reverse():[],...(head?{lastRoutedAt:clock??1}:{})};
      });
    }};
}
