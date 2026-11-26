// The local journal contributes work descriptions, never Session authority.
// Do not use assistant results, handoff content, titles from unrelated sessions,
// or conversations read from disk. The current native roster supplies all IDs.
const cap={tasks:192,items:768,sessions:128,hints:6,chars:4096,totalChars:65536};
const token=s=>typeof s==='string' && s.length>0 && s.length<=160 && !/[\u0000-\u001f]/u.test(s);
export function acceptedWork(tasks,allowed) {
  const index=new Map(),bindings=[];let visited=0,chars=0;
  // Newest tasks first. More recent explicit follow-ups within a task occur last.
  for(const task of tasks.slice(0,cap.tasks)) {
    const items=Array.isArray(task?.items)?task.items:[];
    for(let n=items.length-1;n>=0 && visited<cap.items;n--,visited++) {
      const it=items[n];
      if(it?.accepted!==true || it.attempted!==true || !['create','reuse'].includes(it.decision) ||
        !allowed.has(it.project) || !token(it.sessionId) || !token(it.requestId) ||
        !Number.isSafeInteger(it.afterSeq) || it.afterSeq < -1) continue;
      let group=index.get(it.sessionId);
      if(!group) {
        if(index.size>=cap.sessions) continue;
        group={cwd:it.project,hints:[]};index.set(it.sessionId,group);
        bindings.push({id:it.sessionId,cwd:it.project,requestId:it.requestId,afterSeq:it.afterSeq});
      }
      if(group.cwd!==it.project) {group.conflict=true;continue;}
      // Witness only the original user request. If a user replaced the whole
      // handoff, do not learn a task from a prompt that wasn't actually sent.
      if(typeof it.text!=='string' || (it.payload!==it.text && !(it.approved===true && typeof it.payload==='string' && it.payload.startsWith(it.text+'\n\n')))) continue;
      const hint=it.text.trim();
      // A truncated prefix is not a work identity: a different ticket/date or
      // opposite requested change may appear in the omitted suffix.
      if(hint && hint.length<=cap.chars && chars+hint.length<=cap.totalChars && group.hints.length<cap.hints && !group.hints.includes(hint)) {
        group.hints.push(hint);chars+=hint.length;
      }
    }
    if(visited>=cap.items) break;
  }
  return {bindings:bindings.filter(b=>!index.get(b.id).conflict),
    forPlan(rows) {
      return rows.map(row=>{
        const g=index.get(row.id),hints=g && !g.conflict && g.cwd===row.cwd ? g.hints.slice().reverse() : [];
        return {...row,workHints:hints};
      });
    }};
}
