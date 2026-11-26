import { planRequest } from '../planner/index.mjs';
import { emptyDocument } from './journal.mjs';
import { expectedRecoveryId } from '../host/contract.mjs';
import { acceptedWork, reserveRouteOrder } from './routing-context.mjs';
import { candidateAt, canRemoveTask, isCompletedTask } from './record-policy.mjs';
import { resolveTiers } from './models.mjs';
import { permitted, checkTier, validateSettings, materialize, message, excerpt, creationMode } from './validation.mjs';

const observing = new Set(['queued','running','input-required']);
const detail = e => excerpt(e instanceof Error ? e.message : String(e), 700);
const capResult = 16000;

/** Single-destination outbox; v1 task graphs already on disk keep their original receipts. */
export function createRouter({adapter, journal, infer, plan=planRequest, id=()=>crypto.randomUUID(), now=()=>Date.now()}) {
  let doc = emptyDocument(), sessions=[], workspaces=[], catalog=[], connected=false, notice='', stopped=false, writing=false, storageFailure=null;
  const listeners = new Set();
  let paneIndex=null;
  try { doc=journal.read(); } catch(e) { notice=detail(e); storageFailure=e; }
  // v0.1.1 persisted only the sanitized English message, not its error code.
  // Recognize just the old pre-admission failures. A matching string/key is a
  // UI hint, NOT authority: the owner must explicitly confirm, and the server
  // proves identity, current directory, complete blank history and no queue.
  const legacyCreateMessages=[
    'The router could not confirm a newly created persistent session. Check it manually before starting a new task.',
    'This session identity already exists without a current router creation receipt. Check it manually.',
  ];
  function recoveryId(item) {
    if(item.status!=='failed' || item.attempted || item.accepted || item.configured ||
       (item.decision!=='create' && !item.handedOffEmpty) || !permitted(doc.settings).has(item.project)) return null;
    const id=expectedRecoveryId(item.createKey);
    if(!id || (item.sessionId && item.sessionId!==id)) return null;
    return item.handedOffEmpty || item.errorCode==='router-agent/creation-uncertain' ||
      (!item.errorCode && legacyCreateMessages.some(msg=>item.error?.endsWith(msg))) ? id : null;
  }
  const view = () => {
    const state=structuredClone({settings:doc.settings,tasks:doc.tasks,sessions,workspaces,catalog,connected,notice});
    for(const task of state.tasks) for(const i of task.items) {
      const expected=recoveryId(i);i.recoverableEmpty=!!expected;i.expectedSessionId=expected;
    }
    return state;
  };
  const emit = () => { paneIndex=null; if (stopped || !listeners.size) return; const state=view(); for(const f of listeners) {try{f(state);}catch(e){console.warn('router-agent: view update failed', e?.name);}} };
  const change = () => {
    if (storageFailure) throw storageFailure;
    try { journal.write(doc); } catch(e) { storageFailure=e; notice=detail(e); emit(); throw e; }
    emit();
  };
  const unsub = journal.subscribe(() => { if (!writing && !stopped) { try { doc=journal.read(); } catch(e) { notice=detail(e);storageFailure=e; } emit(); } });
  const operation = fn => journal.exclusive(async () => {
    if(stopped) throw Error('路由入口已关闭。');
    if(storageFailure) throw storageFailure;
    writing=true;
    try { doc=journal.read(); return await fn(); }
    catch(e) { notice=detail(e); emit(); throw e; }
    finally { writing=false; }
  });
  const ensureLive = () => { if (stopped || storageFailure) throw storageFailure || Error('入口已关闭；未开始下一步投递。'); };
  const find = (taskId,itemId) => {
    const task=doc.tasks.find(x=>x.id===taskId), item=task?.items.find(x=>x.id===itemId);
    if(!item) throw Error('分项不存在，请刷新。'); return {task,item};
  };
  async function roster() {
    const allowed = permitted(doc.settings);
    try {
      const work=acceptedWork(doc.tasks,allowed,doc.routeClock);
      sessions=(await adapter.listSessions([...allowed],work.bindings)).filter(s=>allowed.has(s.cwd));connected=true;
      return work;
    }
    catch(e) { sessions=[]; connected=false; emit(); throw e; }
  }
  async function resources() {
    const [w,m] = await Promise.all([adapter.listWorkspaces(), adapter.catalog()]);
    workspaces=w; catalog=m;
  }
  function allowedProject(item) {
    if (!permitted(doc.settings).has(item.project)) throw Error('目标目录已不在设置的许可范围，已停止此项。');
  }
  function existing(item) {
    allowedProject(item);
    if(!sessions.some(s=>s.id===item.sessionId && s.cwd===item.project)) throw Error('绑定的会话已归档、已移出目录或不再可用；请检查原会话。不会换投其他会话。');
  }
  async function proveCreated(item) {
    allowedProject(item); ensureLive();
    // Freeze the native preset with the original creation key. Legacy in-flight
    // records have no explicit preset: never change a previously issued intent.
    const real=await adapter.createSession(item.project,item.createKey,item.agentPreset?{agentPreset:item.agentPreset}:undefined);
    if (!real || (item.sessionId && real!==item.sessionId)) throw Error('新建会话的身份无法确认，不会改投或覆盖。');
    if (!item.sessionId) { item.sessionId=real;change(); }
  }
  // On a new tab an accepted but still blank Session is absent from the candidate
  // list. Only same-key host proof can recover it; never guess from cwd/title.
  async function checkObservationTarget(item) {
    allowedProject(item);
    if(sessions.some(s=>s.id===item.sessionId && s.cwd===item.project)) return;
    if(item.handedOffEmpty && item.attempted && !sessions.some(s=>s.id===item.sessionId)) {
      await adapter.bindRecoveryObservation(item.project,item.createKey,item.sessionId);return;
    }
    if(item.decision==='create' && item.sessionId && !sessions.some(s=>s.id===item.sessionId)) {await proveCreated(item);return;}
    existing(item);
  }
  function advance(task) {
    let changed=false;
    for(const item of task.items) {
      if (!['new','waiting','handoff','clarify'].includes(item.status)) continue;
      const deps=item.dependsOn.map(k=>task.items.find(x=>x.id===k));
      let status = 'new';
      if(deps.some(d=>d?.status!=='done')) status='waiting';
      else if(item.decision==='clarify') status='clarify';
      else if(deps.length && !item.approved) {
        status='handoff';
        if(item.handoff===undefined) {
          // This is the entire proposed recipient message, not a hidden preamble. No history.
          const budget=Math.floor(7000/deps.length);
          item.handoff=item.text+'\n\n已完成的前置工作（确认后才传递）：\n'+deps.map((d,i)=>'['+(i+1)+'] '+excerpt(d.text,120)+'\n'+excerpt(d.result || '（无文本结果，请补充要交接的内容。）',budget)).join('\n\n');
          changed=true;
        }
      }
      if(item.status!==status) {item.status=status;changed=true;}
    }
    if(changed) change();
  }
  async function dispatch(item, confirmedEmptySessionId=null, batch) {
    try {
      allowedProject(item); ensureLive(); item.status='dispatching'; item.error=''; delete item.errorCode; item.retryable=false; change();
      if(item.decision==='create') {
        if (!item.configured) checkTier(item.selection,catalog);
        // A restarted host may lack its original create receipt. If we already
        // attempted admission, we need only the persisted, scope-checked binding.
        if (item.attempted && item.configured && sessions.some(s=>s.id===item.sessionId && s.cwd===item.project)) existing(item);
        else await proveCreated(item);
        if (!item.configured) {
          ensureLive();await adapter.configure(item.sessionId,item.selection);
          item.appliedSelection={...item.selection};item.configured=true;change();
        }
      } else if (!(item.handedOffEmpty && confirmedEmptySessionId && item.sessionId===confirmedEmptySessionId && !item.attempted)) existing(item);
      if (!Number.isSafeInteger(item.afterSeq)) {
        const cursor=await adapter.cursor(item.sessionId); if(!Number.isSafeInteger(cursor) || cursor < -1) throw Error('无法取得会话游标；未投递。');
        item.afterSeq=cursor;
      }
      // Write target, text, cursor and request ID *before* admission, including retries.
      item.payload ??= item.approved ? item.handoff : item.text;
      reserveRouteOrder(doc,item,now(),batch);
      item.attempted=true; change(); ensureLive();
      await adapter.deliver(item.sessionId,item.requestId,item.payload);
      item.accepted=true; item.status='queued'; item.error=''; item.retryable=false; change();
    } catch(e) {
      if(storageFailure) throw storageFailure;
      item.status=item.attempted?'unknown':'failed'; item.retryable=true;
      if(typeof e?.code==='string' && e.code.startsWith('router-agent/')) item.errorCode=e.code;
      item.error=(item.attempted?'投递回执不确定。核对原会话，或用同一请求号重试：':'未完成投递：')+detail(e); change();
    }
  }
  async function pump(task) {
    if(task.kind==='conversation') {
      // The first message plus optional follow-ups; they all belong to one
      // conversation. No graph, fan-out, context transfer or parallel dispatch.
      for(const item of task.items) if(item.status==='new') {
        ensureLive();
        if(item.decision==='clarify') {item.status='clarify';change();}
        else await dispatch(item);
      }
      return;
    }
    // Compatibility only: keep the identities and approval gates of records
    // persisted by 0.1.x; never convert or replay them as new conversations.
    advance(task);
    const ready=task.items.filter(x=>x.status==='new'), batch=ready.length>1?{}:null;
    async function worker() { let i; while ((i=ready.shift())) { ensureLive(); await dispatch(i,null,batch); } }
    await Promise.all(Array.from({length:Math.min(4,ready.length)},worker));
  }
  async function observe(item) {
    let reading;
    try {await checkObservationTarget(item); reading=await adapter.observe(item.sessionId,item.requestId,item.afterSeq);}
    catch(e) {reading={status:'unknown',error:'暂时不能核对该分项：'+detail(e)};}
    const valid=reading && ['queued','running','input-required','done','failed','unknown'].includes(reading.status);
    if(!valid) reading={status:'unknown',error:'宿主未返回可归属的状态，请打开原会话核对。'};
    const status=reading.status, result=excerpt(reading.result,capResult), error=excerpt(reading.error,900);
    // Retry only an indeterminate admission, never replay a failed/completed agent turn.
    const retryable=status==='unknown' && !item.accepted && !!item.attempted;
    if (item.status===status && (item.result||'')===result && (item.error||'')===error && !!item.retryable===retryable && (status==='unknown' || item.accepted===true)) return;
    Object.assign(item,{status,result,error,retryable});
    if(['queued','running','input-required','done','failed'].includes(status)) item.accepted=true;
    change();
  }
  async function reconcile(manual) {
    for(const t of doc.tasks) {
      for(const i of t.items) {
        if(i.status==='dispatching' && !i.attempted) {
          // The browser stopped mid-create/configure, before first prompt. No auto-replay.
          Object.assign(i,{status:'failed',retryable:true,error:'上次准备投递时中断；可使用同一创建标识继续。'}); change();
        } else if(observing.has(i.status) || i.status==='dispatching' || (manual && i.status==='unknown')) await observe(i);
      }
      await pump(t);
    }
  }
  async function refresh() {
    return operation(async()=>{
      notice=''; await roster();
      let resourceError;
      try {await resources();} catch(e) {catalog=[];resourceError=e;notice='未能读取工作区或模型目录：'+detail(e);}
      await reconcile(true); emit(); if(resourceError) throw Error(notice);
    });
  }
  async function preview(input) {
    const work=await roster();
    try {await resources();notice='';} catch(e) {catalog=[];notice='模型目录不可用。明确的旧任务仍可续接，新会话暂不派发：'+detail(e);}
    const effective={...doc.settings,tiers:resolveTiers(doc.settings,catalog)};
    const recent=async sid=>{if(!sessions.some(s=>s.id===sid)) throw Error('候选会话不在许可范围。');return adapter.recent(sid);};
    const classify=!infer?undefined:async data=>{
      try{return await infer({...data,...checkTier(effective.tiers.fast,catalog)});}
      catch(e){notice='意图模型不可用，本次使用本地路由规则：'+detail(e);throw e;}
    };
    const planned=await plan({text:input,settings:structuredClone(effective),sessions:work.forPlan(structuredClone(sessions)),getRecent:recent,infer:classify});
    return {effective,planned};
  }
  // The list and the task must independently name this session. A stored ID,
  // creation receipt, or recovered observation alone cannot open a chat. The
  // pane must also watch the current native scope while it is mounted.
  function sessionPaneTarget(sid) {
    if(stopped || !connected || storageFailure || typeof sid!=='string' || !sid) return null;
    // Compact history can show hundreds of rows. Build the UI index once per
    // snapshot, not one full journal scan for every row/turn on every redraw.
    if(paneIndex?.doc!==doc || paneIndex.sessions!==sessions) {
      const allowed=permitted(doc.settings), rows=new Map(sessions.filter(s=>allowed.has(s.cwd)).map(s=>[s.id,s]));
      const bound=new Map(), targets=new Map();
      for(const task of doc.tasks) for(const i of task.items) {
        if(i.sessionId && rows.has(i.sessionId)) {
          const row=rows.get(i.sessionId), match=bound.get(i.sessionId)!==false && i.project===row.cwd;
          bound.set(i.sessionId,match);
        }
        if(i.status==='clarify' && Array.isArray(i.candidates)) for(const candidate of i.candidates) {
          const row=rows.get(candidate);if(candidateAt(i,candidate,row?.cwd)) targets.set(candidate,row.cwd);
        }
      }
      for(const [id,ok] of bound) {if(ok) targets.set(id,rows.get(id).cwd);else targets.delete(id);}
      paneIndex={doc,sessions,targets};
    }
    return paneIndex.targets.get(sid) ?? null;
  }
  function saveRemaining(tasks) {
    // Publish the smaller list only after storage accepted it. No native call:
    // this is not a cancel, an archive, or a deleteSession operation.
    const next={...doc,tasks};
    if(doc.routeClock===undefined) {
      // v0.2.0 has no watermark. Removing one of several admitted targets must
      // not make the remaining one appear to be the last conversation. Keep no ID.
      const keep=new Set(tasks);
      if(doc.tasks.some(t=>!keep.has(t) && t.items.some(i=>i.accepted || i.attempted))) next.routeClock=0;
    }
    try { journal.write(next); } catch(e) {storageFailure=e;throw e;}
    doc=next;emit();
  }
  const api={
    getState:view, sessionPaneTarget,
    async removeTask(taskId) {return operation(async()=>{
      const task=doc.tasks.find(t=>t.id===taskId); if(!task) return 0;
      if(!canRemoveTask(task) || task.items.some(recoveryId)) throw Error('记录仍在执行、等待回执或需要恢复，未清理。');
      saveRemaining(doc.tasks.filter(t=>t!==task));return 1;
    });},
    async clearCompleted(taskIds=doc.tasks.filter(isCompletedTask).map(t=>t.id)) {
      if(!Array.isArray(taskIds) || taskIds.some(t=>typeof t!=='string')) throw Error('待清理的记录列表无效。');
      const confirmed=new Set(taskIds);
      return operation(async()=>{
        const keep=doc.tasks.filter(t=>!confirmed.has(t.id) || !isCompletedTask(t));
        const count=doc.tasks.length-keep.length;if(count) saveRemaining(keep);return count;
      });
    },
    subscribe(fn) {listeners.add(fn);return ()=>listeners.delete(fn);},
    async saveSettings(raw) {return operation(async()=>{await resources(); const settings=validateSettings(raw,catalog);doc.settings=settings;change();await roster();notice='设置已保存';emit();});},
    refresh,
    async submit(text) {return operation(async()=>{
      const input=message(text); if(!doc.settings.generalDir) throw Error('先设置通用目录和三个模型档，再发送任务。');
      const {effective,planned}=await preview(input);
      const task={id:id(),kind:'conversation',text:input,createdAt:now(),items:materialize(planned,effective,sessions,id,input)};
      // The model call may take time; check archive/working-directory changes again.
      await roster(); ensureLive();doc.tasks.unshift(task);change();await pump(task);return task.id;
    });},
    // Old clarify records can carry an empty, outdated candidate list. Recompute
    // ONLY this standalone, never-attempted item's suggestion, not its authority.
    // No execution Session, model selection or task prompt is created; confirmation is
    // still a separate action with the original item/request/create identities.
    async reviewRoute(t,k) {return operation(async()=>{
      const {item}=find(t,k);
      if(item.status!=='clarify' || item.decision!=='clarify' || item.sessionId || item.attempted || item.accepted || item.configured || item.dependsOn?.length) throw Error('只能重新匹配尚未投递、无依赖且正在等待选择的原分项。');
      const {effective,planned}=await preview(message(item.text));
      await roster();ensureLive();
      const [suggested]=materialize(planned,effective,sessions,()=> 'preview',message(item.text));
      item.candidates=suggested.candidates.slice();item.candidateDirs=suggested.candidateDirs;item.project=suggested.project;
      item.tier=suggested.tier;item.selection={...suggested.selection};
      item.reason='重新匹配（未发送）：'+suggested.reason;
      if(suggested.decision==='reuse' && !item.candidates.includes(suggested.sessionId)) {
        item.candidates.unshift(suggested.sessionId);item.candidateDirs[suggested.sessionId]=suggested.project;
      }
      change();
      return suggested.decision==='reuse'?{kind:'reuse',sessionId:suggested.sessionId}:
        suggested.decision==='create'?{kind:'create',project:suggested.project}:null;
    });},
    async resolve(t,k,choice) {return operation(async()=>{
      const {task,item}=find(t,k);if(item.status!=='clarify') throw Error('该分项现在不需要选择目标。'); await roster();
      if(choice?.kind==='reuse') {
        const s=sessions.find(x=>x.id===choice.sessionId);
        if(!candidateAt(item,choice.sessionId,s?.cwd,true)) throw Error('所选会话不在本项当前候选或原目录中；请重新匹配后再确认。');
        item.sessionId=s.id;item.project=s.cwd;
      } else if(choice?.kind==='create' && permitted(doc.settings).has(choice.project)) {
        item.project=choice.project;item.sessionId=null;item.selection={...resolveTiers(doc.settings,catalog)[item.tier]};
        // A 0.1.2 clarify item has never started a create. Unlike an old failed
        // key, it can use today's mode when the owner first authorizes creation.
        if(!item.sessionMode && !item.attempted && !item.configured) {
          item.sessionMode=creationMode(doc.settings.sessionMode);
          if(item.sessionMode!=='inherit') item.agentPreset=item.sessionMode;
        }
      }
      else throw Error('请选择许可范围内的目标。');
      item.decision=choice.kind;item.reason='你已选择'+(choice.kind==='reuse'?'续接此会话。':'在此目录新建。');item.status='new';change();await pump(task);
    });},
    async approve(t,k,text) {return operation(async()=>{
      const {task,item}=find(t,k);if(item.status!=='handoff' || item.dependsOn.some(key=>task.items.find(i=>i.id===key)?.status!=='done')) throw Error('前置项尚未完成或已确认，不能交接。');
      const exact=message(text,32000);await roster();item.handoff=exact;item.approved=true;item.status='new';change();await pump(task);
    });},
    async followUp(t,k,text) {return operation(async()=>{
      const {task,item}=find(t,k);const input=message(text);
      if (!item.sessionId || !item.accepted || item.status==='input-required') throw Error('只有已投递并绑定的分项可追问；原会话的审批请在原处处理。');
      await roster();existing(item);
      const next={id:id(),text:input,parentItemId:k,dependsOn:[],decision:'reuse',project:item.project,tier:item.tier,sessionId:item.sessionId,candidates:[],reason:'追问留在原会话，沿用它的模型。',status:'new',requestId:'ra-'+id()};
      task.items.push(next);change();await pump(task);return next.id;
    });},
    async recoverEmpty(t,k,expectedId) {return operation(async()=>{
      const {task,item}=find(t,k), target=recoveryId(item);
      if(!target || target!==expectedId) throw Error('恢复目标或分项状态已改变，未发送。');
      if(item.dependsOn.some(key=>task.items.find(i=>i.id===key)?.status!=='done') || (item.dependsOn.length && !item.approved)) throw Error('前置工作或交接内容尚未确认。');
      await roster();allowedProject(item);ensureLive();
      let confirmed;
      try {confirmed=await adapter.recoverEmpty(item.project,item.createKey,target);}
      catch(e) {
        if(e?.code==='router-agent/recovery-not-found' || e?.code==='router-agent/recovery-unsafe') {
          item.errorCode=e.code;item.error='恢复未执行：'+detail(e);item.retryable=e.code==='router-agent/recovery-not-found' && !item.handedOffEmpty;change();
        }
        throw e;
      }
      if(confirmed!==target) throw Error('宿主未确认同一空会话，未投递。');
      // Explicit ordinary reuse; never write a model or call create here.
      item.sessionId=target;item.decision='reuse';item.handedOffEmpty=true;
      item.reason='你已确认接回这个空会话，沿用它的当前模型，只发送原分项。';
      // Never leave an auto-dispatchable state on disk before the outbox commit.
      // A tab crash before admission will ask for confirmation again.
      delete item.afterSeq;item.status='dispatching';item.retryable=false;change();
      await dispatch(item,target);
    });},
    async retry(t,k) {return operation(async()=>{
      const {item}=find(t,k);
      if(recoveryId(item)) throw Error('该分项可能已有空会话，请先核对原目录和会话标识并明确确认恢复，不会另建。');
      if(!item.retryable || !['failed','unknown'].includes(item.status)) throw Error('此分项不能重新投递，请打开原会话核对。');
      await roster();if(!item.configured && !item.attempted && item.decision==='create') {await resources();item.selection={...resolveTiers(doc.settings,catalog)[item.tier]};}
      await dispatch(item);
    });},

    async tick() {return operation(async()=>{
      if(!doc.tasks.some(t=>t.items.some(i=>observing.has(i.status) || ['new','dispatching'].includes(i.status)))) return;
      await roster();await reconcile(false);
    });},
    dispose() {stopped=true;listeners.clear();unsub();},
  };
  return api;
}
