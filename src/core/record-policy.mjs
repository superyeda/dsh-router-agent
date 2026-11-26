// Clearing a ledger row is not a session operation. Keep receipts that the
// outbox still needs for observation, uncertain admission, or empty recovery.
export const isCompletedTask = task => Array.isArray(task?.items) && task.items.length>0 && task.items.every(i=>i?.status==='done');
export function canRemoveTask(task) {
  return Array.isArray(task?.items) && task.items.length>0 && task.items.every(i=>{
    if(i?.status==='done') return true;
    if(i?.status==='clarify') return !i.sessionId && !i.attempted && !i.accepted && !i.configured;
    if(i?.status!=='failed' || i.recoverableEmpty || (i.attempted && !i.accepted)) return false;
    // A confirmed terminal turn, or a definitely unsent failure. A possible
    // native blank-session claim needs an explicit recovery decision instead.
    return true;
  });
}

// New candidate IDs carry their original cwd. Unscoped legacy choices can still be
// confirmed manually by the controller, but cannot be used for a session preview.
export function candidateAt(item, sid, cwd, manual=false) {
  if (!cwd || !Array.isArray(item?.candidates) || !item.candidates.includes(sid) || (item.project && item.project!==cwd)) return false;
  return item.candidateDirs ? Object.hasOwn(item.candidateDirs,sid) && item.candidateDirs[sid]===cwd : item.project===cwd || manual;
}
