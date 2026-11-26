import { css } from './style.mjs';
import { STATUS, list, str, statusOf, matchesFilter, recordCaption, candidateAt, pairKey, catalogEntries, directoryOptions, checkSettings, uiKit, text, val, msg, options, order, shortcut, errorMessage } from './shared.mjs';
import { createSettings } from './settings.mjs';
import { createTask, hasItemDraft } from './tasks.mjs';
import { canRemoveTask, isCompletedTask } from '../core/record-policy.mjs';

// Unsaved text stays in memory. Verified hosts may share an object across remounts for one
// owner/DSH instance; unrelated controllers never inherit it. Nothing unsubmitted goes to storage.
const draftsByAPI = new WeakMap();
const empty = () => ({settings:{},tasks:[],workspaces:[],catalog:[],sessions:[],connected:false,notice:''});

// The native view owns its container, never the workbench or its navigation. Each
// mount gets a distinct host: even a late async mount cannot write into its successor.
let paneSerial=0;
function createSessionDock(ctx) {
  const {el,button,live}=ctx.ui, node=el('aside','rt-session-side'), notice=live(); node.setAttribute('aria-label','原会话侧栏'); node.id='rt-session-side-'+(++paneSerial); node.hidden=true;
  const chrome=el('div','dshr rt-pane-chrome'), heading=el('div'), title=el('h2'), address=el('p','rt-muted');
  const closeButton=button('关闭侧栏',()=>{close(true);ctx.paint();},'rt-btn');
  heading.append(el('p','rt-eyebrow','原会话 · 页内查看'),title,address); chrome.append(heading,closeButton);
  const body=el('div','rt-pane-body'); node.append(chrome,body);
  let current=null;
  function target(ref) {
    if(!ctx.online || !ctx.onBoard || !ref?.sid || typeof ctx.api.mountSessionPane!=='function') return null;
    const task=ctx.byTask.get(ref.taskId); if(!task || !matchesFilter(task,ctx.filter)) return null;
    const item=list(task.items).find(i=>i.id===ref.itemId);
    if(!item || (ctx.filter && statusOf(item)!==ctx.filter) || (ref.kind==='candidate' ? item.status!=='clarify' || !list(item.candidates).includes(ref.sid) : ref.kind!=='bound' || item.sessionId!==ref.sid)) return null;
    // Never substitute an old journal sessionId, a title, or a recovery hint for actual authority.
    let cwd;
    try {cwd=typeof ctx.api.sessionPaneTarget==='function' ? ctx.api.sessionPaneTarget(ref.sid) : ctx.sessions.get(ref.sid)?.cwd;}
    catch {return null;}
    return typeof cwd==='string' && ctx.dirs.some(d=>d.value===cwd) && (ref.kind==='candidate' ? candidateAt(item,ref.sid,cwd) : item.project===cwd) ? cwd : null;
  }
  function release(fn) {
    if (typeof fn==='function') {
      // Cleanup may itself be async; a stale lease no longer owns any visible DOM.
      const failed=()=>{if(ctx.alive()) msg(notice,'关闭会话视图时出错，请刷新状态。','amber');};
      try {Promise.resolve(fn()).catch(failed);} catch {failed();}
    }
  }
  function close(restore=false) {
    const prev=current; current=null; node.hidden=true;
    if(!prev) return;
    const fn=prev.cleanup; prev.cleanup=null; release(fn); prev.host.remove();
    if(restore && prev.trigger?.isConnected!==false) prev.trigger?.focus();
  }
  function update() {
    if(!current) return false;
    if(target(current.ref)!==current.cwd) {
      close(); if(ctx.onBoard) msg(notice,'已关闭侧栏：连接、记录或会话的许可范围已变化。','amber'); return false;
    }
    const s=ctx.sessions.get(current.ref.sid); text(title,s?.title || '关联会话'); text(address,current.ref.sid+' · '+current.cwd); return true;
  }
  function open(ref,trigger) {
    if(!ctx.alive()) return;
    const cwd=target(ref);
    if(!cwd) {msg(notice,'目前不能在侧栏查看这个会话，请刷新连接并核对目标目录。','amber');ctx.paint();return;}
    const r=current?.ref;
    if(r && r.sid===ref.sid && r.taskId===ref.taskId && r.itemId===ref.itemId && r.kind===ref.kind && current.cwd===cwd) {closeButton.focus();return;}
    close(); if(!ctx.alive() || target(ref)!==cwd) return;
    msg(notice); const host=el('div','rt-pane-mount'); host.setAttribute('data-session-id',ref.sid);
    const lease={ref,cwd,host,trigger,cleanup:null}; current=lease; body.append(host); node.hidden=false; ctx.paint();
    if(current!==lease) return;
    const failed=err=>{if(current===lease) {close();msg(notice,'无法在侧栏显示会话：'+errorMessage(err),'red');ctx.paint();}};
    function mounted(cleanup) {
      if(typeof cleanup!=='function') {failed(Error('宿主未提供有效的会话视图。'));return;}
      if(current===lease) lease.cleanup=cleanup; else release(cleanup);
    }
    try {
      const result=ctx.api.mountSessionPane(host,ref.sid);
      if(typeof result?.then==='function') Promise.resolve(result).then(mounted,failed); else mounted(result);
    } catch(err) {failed(err);}
    if(current===lease) closeButton.focus();
  }
  return {node,notice,target,open,update,close,selected:id=>current?.ref.taskId===id};
}

// Preview and commit are separate user actions. The IDs, not a live predicate,
// are the maximum scope approved by a bulk confirmation.
function createRecordCleanup(ctx) {
  const {el,button,live}=ctx.ui, batchSlot=el('div'), feedback=live();
  const bulk=button('清理已完成',askBatch), box=el('div','rt-clean-confirm'); box.setAttribute('role','group'); box.setAttribute('aria-label','确认清理路由记录');
  const prompt=el('p','rt-instruction'), scope=el('details'), entries=el('ul'), controls=el('div','rt-actions'); scope.append(el('summary','','核对记录列表'),entries);
  const cancel=button('取消',()=>leave(undefined,true)); box.append(prompt,scope,controls);
  const rules=el('details','rt-clean-rules'); rules.append(el('summary','','清理规则'),el('p','rt-muted','批量清理只移除当前列表中全部已完成的记录。未发送的待选择记录，以及投递结果确定且无需恢复的失败记录，可在详情中单独删除。运行、排队、回执未知、待交接或待恢复的记录会保留。清记录不删除原会话或消息。'));
  let preview=null, confirm=null;
  const canAsk=()=>ctx.alive() && ctx.onBoard && ctx.readable && !ctx.busy(feedback);
  const eligible=t=>!!t && isCompletedTask(t) && canRemoveTask(t);
  const batch=()=>ctx.state.tasks.filter(t=>matchesFilter(t,ctx.filter) && eligible(t));
  function leave(id,restore=false) {
    if(!preview || (id!==undefined && (preview.batch || !preview.ids.includes(id)))) return;
    const trigger=preview.trigger; preview=null; box.remove(); entries.replaceChildren();
    if(restore && trigger.isConnected!==false) trigger.focus();
  }
  function begin(tasks,many,slot,trigger) {
    leave(); msg(feedback); const ids=tasks.map(t=>t.id); preview={batch:many,ids,trigger};
    const name=recordCaption(tasks[0]), withDraft=tasks.some(t=>list(t.items).some(i=>{const d=ctx.memory.items.get(pairKey(t.id,i.id));return d && hasItemDraft(d);}));
    text(prompt,(many?'清理当前列表中的 '+ids.length+' 条已完成记录？之后完成的记录不在本次范围内。':'从任务记录中删除「'+name+'」？')+'只移除本机路由记录，不会删除原会话或消息，也不会停止会话。此操作无法撤销。'+(withDraft?' 未发送的草稿将保留在页面中，仅供复制。':''));
    const reviewed=preview; confirm=button(many?'确认清理已完成记录':'确认删除这条记录',()=>{if(preview===reviewed) send();},'rt-btn rt-danger'); controls.replaceChildren(cancel,confirm); scope.hidden=!many; scope.open=false;
    if(many) entries.replaceChildren(...tasks.map(t=>el('li','',recordCaption(t)+' · '+t.id)));
    confirm.disabled=cancel.disabled=false; slot.append(box); cancel.focus();
  }
  function askOne(id,slot,trigger) {const t=ctx.byTask.get(id); if(canAsk() && t && canRemoveTask(t) && typeof ctx.api.removeTask==='function') begin([t],false,slot,trigger);}
  function askBatch() {const rows=batch(); if(canAsk() && rows.length && typeof ctx.api.clearCompleted==='function') begin(rows,true,batchSlot,bulk);}
  function send() {
    if(!preview || !canAsk()) return;
    const p=preview, ok=p.batch?eligible:t=>!!t && canRemoveTask(t);
    ctx.run(feedback,p.batch?'清理已完成记录':'删除记录',async()=>{
      const fresh=await ctx.api.getState();
      if(!ctx.alive() || !ctx.readable || preview!==p || !Array.isArray(fresh?.tasks)) throw Error('确认已失效，请刷新后重新核对。');
      const latest=new Map(fresh.tasks.map(t=>[t.id,t]));
      const ids=p.ids.filter(id=>ok(ctx.byTask.get(id)) && ok(latest.get(id)));
      if(!ids.length) return 0;
      return p.batch?ctx.api.clearCompleted(ids):ctx.api.removeTask(ids[0]);
    },n=>{leave(); return n===0?'没有移除记录：记录状态已变化或已清理。':'已移除 '+n+' 条本机路由记录；原会话和消息保持不变。';},{offline:true});
  }
  function update() {
    const busy=ctx.busy(feedback), available=batch().length;
    bulk.disabled=!canAsk() || !available || typeof ctx.api.clearCompleted!=='function';
    bulk.title=available?'只清理当前列表中全部已完成的 '+available+' 条记录':'当前列表没有可清理的已完成记录';
    cancel.disabled=busy || !ctx.readable; if(confirm) confirm.disabled=cancel.disabled;
    if(preview && !busy && (!ctx.onBoard || !ctx.readable || (!preview.batch && !canRemoveTask(ctx.byTask.get(preview.ids[0]))))) {
      leave(); msg(feedback,'确认已失效，未删除记录。请重新核对。','amber');
    }
  }
  return {bulk,batchSlot,feedback,rules,askOne,canAsk,update,leave};
}

/** Mount inside a dedicated DSH surface. No host registration, navigation or network side effects. */
export function mountRouter(root,api) {
  const doc=root.ownerDocument || document, ui=uiKit(doc), {el,button,field,live}=ui;
  const scope=api.draftScope && typeof api.draftScope==='object' ? api.draftScope : api;
  const memory=draftsByAPI.get(scope) || {compose:'',rev:0,settings:null,items:new Map()}; draftsByAPI.set(scope,memory);
  const pending=new Set(), taskViews=new Map();
  let disposed=false, unsubscribe, version=0, readError='', subError='', chooseInitial=true, view='board';
  const ctx={api,ui,memory,state:empty(),byTask:new Map(),loaded:false,online:false,readable:false,onBoard:true,ready:false,filter:'',models:[],sessions:new Map(),dirs:[],
    alive:()=>!disposed,busy:n=>pending.has(n),run,paint,markSettingsDirty,goBoard:()=>navigate('board')};
  ctx.pane=createSessionDock(ctx); ctx.cleanup=createRecordCleanup(ctx);
  const shell=el('div','dshr-shell'); shell.setAttribute('lang','zh-CN');
  const sheet=el('style'); sheet.textContent=css;
  const wrap=el('div','rt-wrap'), mast=el('div','dshr'), workbench=el('div','rt-workbench'), header=el('header','rt-header'), brand=el('div','rt-brand'), mark=el('div','rt-mark','↗'); mark.setAttribute('aria-hidden','true');
  const identity=el('div'); identity.append(el('p','rt-eyebrow','DSH　/　个人工作区'),el('h1','','任务路由台')); brand.append(mark,identity);
  const tools=el('div','rt-tools'), online=el('span','rt-connection'); online.setAttribute('role','status');
  const refreshNotice=live(), refresh=button('刷新状态',()=>run(refreshNotice,'刷新状态',()=>api.refresh(),()=> '已刷新状态。',{offline:true}));
  tools.append(online,refresh);
  const nav=el('nav','rt-nav'); nav.setAttribute('aria-label','任务路由导航');
  const boardTab=button('任务台',()=>navigate('board'),'rt-nav-btn'), settingsTab=button('路由设置',()=>navigate('settings'),'rt-nav-btn'); nav.append(boardTab,settingsTab); header.append(brand,nav,tools);
  const connection=live(), remoteNotice=live(), subscriptionNotice=live();
  const board=el('div','dshr rt-board'), composeBox=el('form','rt-compose rt-card'); composeBox.noValidate=true;
  const compose=el('textarea'), composerFeedback=live(); compose.rows=2; compose.placeholder='例如：检查网站项目的发布说明，列出需要更新的内容。'; compose.value=memory.compose;
  const send=el('button','rt-btn rt-primary','提交任务'); send.type='submit';
  const composeFoot=el('div','rt-compose-foot'); composeFoot.append(el('span','rt-muted','⌘ / Ctrl + Enter 提交'),composerFeedback,send);
  const setupWarning=el('div','rt-setup-warning'), setupReason=el('span');
  setupWarning.append(setupReason,button('去路由设置',()=>navigate('settings'),'rt-btn rt-quiet'));
  const composeHead=el('div','rt-compose-head'); composeHead.append(el('h2','','新建任务'),el('p','rt-muted','整段内容只发往一个会话。去向不明确时，先请你选择。'));
  composeBox.append(composeHead,field('任务内容',compose),composeFoot,setupWarning);
  compose.addEventListener('input',()=>{memory.compose=compose.value; memory.rev++;});
  composeBox.addEventListener('submit',e=>{e.preventDefault();submit();}); shortcut(compose,submit);
  const ledger=el('section','rt-ledger'), ledgerHead=el('div','rt-ledger-head'), filter=el('select');
  const ledgerTitle=el('div'), stats=el('p','rt-muted'), ledgerTools=el('div','rt-tools');
  ledgerTitle.append(el('h2','','任务记录'),stats); ledgerTools.append(field('按状态筛选',filter),ctx.cleanup.bulk); ledgerHead.append(ledgerTitle,ledgerTools);
  filter.addEventListener('change',()=>{ctx.cleanup.leave();ctx.filter=filter.value;paint();});
  const cards=el('div','rt-task-list'), blank=el('div','rt-empty rt-card'), blankTitle=el('h3'), blankBody=el('p','rt-muted');
  cards.setAttribute('role','region'); cards.setAttribute('aria-label','任务历史'); cards.tabIndex=0;
  blank.append(blankTitle,blankBody); ledger.append(ledgerHead,ctx.cleanup.batchSlot,ctx.cleanup.feedback,blank,cards,ctx.cleanup.rules);
  const orphan=el('section','rt-card rt-orphan'), orphanText=el('pre','rt-user-text');
  orphan.append(el('h3','','已离开列表的草稿'),el('p','rt-muted','这些记录已不在当前列表。未提交的草稿仍可复制，不会发送到其他会话。'),orphanText);
  board.append(composeBox,ledger,orphan);
  const settings=createSettings(ctx), settingsRegion=el('div','dshr'); settingsRegion.append(settings.node);
  // The native Conversation is a sibling of all .dshr-styled UI, not a descendant.
  mast.append(header,connection,subscriptionNotice,remoteNotice,refreshNotice,ctx.pane.notice);
  workbench.append(board,ctx.pane.node); wrap.append(mast,workbench,settingsRegion); shell.append(sheet,wrap); root.append(shell);

  function navigate(to) {if (!disposed) {if(to!==view) ctx.cleanup.leave();view=to;chooseInitial=false;paint();}}
  function markSettingsDirty() {text(settingsTab,'路由设置'+(memory.settings?.dirty?' · 未保存':''));}
  function submit() {
    if (!ctx.online || !ctx.ready || pending.has(composerFeedback)) return;
    const value=compose.value, rev=memory.rev;
    if (!value.trim()) {msg(composerFeedback,'请先填写任务内容。','red'); compose.focus(); return;}
    run(composerFeedback,'提交任务',()=>api.submit(value),()=>{
      if (rev===memory.rev) {memory.compose=''; val(compose,'');}
      return '任务已提交，可在下方查看状态和会话。';
    });
  }
  async function run(slot,label,work,accepted,{offline=false}={}) {
    if (disposed || pending.has(slot)) return;
    if (!offline && !ctx.online) {msg(slot,'尚未连接，不能'+label+'。当前输入已保留。','red');return;}
    pending.add(slot); msg(slot,'正在'+label+'…'); paint();
    try {
      const result=await work();
      if (result?.ok===false) throw new Error(str(result.error || result.message || '操作被拒绝'));
      if (disposed) return;
      msg(slot,accepted?.(result) || (label+'成功。'),'green'); receive();
    } catch (error) {
      if (!disposed) msg(slot,label+'失败：'+errorMessage(error),'red');
    } finally {pending.delete(slot); if (!disposed) paint();}
  }
  function paint() {
    if (disposed) return;
    ctx.readable=ctx.loaded && !readError; ctx.online=ctx.readable && ctx.state.connected; ctx.onBoard=view==='board';
    text(online,readError?'状态不可用':!ctx.loaded?'正在连接':ctx.online?'已连接':'未连接'); online.setAttribute('data-on',String(ctx.online));
    msg(connection,readError ? '读取入口状态失败：'+readError+'。可刷新重试，现有草稿已保留。'
      : !ctx.loaded ? '正在读取任务、目录和模型…' : !ctx.online ? '未连接到 DSH。显示的是上次已知状态；仍可编辑草稿，恢复连接后再发送。' : '',readError?'red':'amber');
    msg(subscriptionNotice,subError ? '实时更新不可用：'+subError+'。请使用「刷新状态」。' : '','amber');
    msg(remoteNotice,ctx.state.notice,/(授权|失败|错误|forbidden|unauthorized|error)/i.test(ctx.state.notice)?'red':'info');
    refresh.disabled=pending.has(refreshNotice); text(refresh,refresh.disabled?'正在刷新…':'刷新状态');
    workbench.hidden=!ctx.onBoard; settingsRegion.hidden=ctx.onBoard;
    boardTab.setAttribute('aria-pressed',String(ctx.onBoard)); settingsTab.setAttribute('aria-pressed',String(!ctx.onBoard));
    workbench.setAttribute('data-pane',ctx.pane.update()?'open':'closed'); ctx.cleanup.update();
    settings.update(); markSettingsDirty();
    send.disabled=!ctx.online || !ctx.ready || pending.has(composerFeedback); text(send,pending.has(composerFeedback)?'正在提交…':'提交任务');
    setupWarning.hidden=!ctx.loaded || ctx.ready; text(setupReason,'路由尚未就绪：'+(ctx.setupIssue || '请完成设置。'));
    const tasks=ctx.state.tasks, counts=new Map(); let attention=0, active=0;
    for (const task of tasks) {
      const statuses=new Set(list(task.items).map(statusOf)); for(const s of statuses) counts.set(s,(counts.get(s)||0)+1);
      if(['clarify','handoff','input-required'].some(s=>statuses.has(s))) attention++;
      if(['running','queued','dispatching'].some(s=>statuses.has(s))) active++;
    }
    const n=s=>counts.get(s)||0; text(stats,'共 '+tasks.length+' 条 · 待处理 '+attention+' · 进行中 '+active+' · 已完成 '+tasks.filter(isCompletedTask).length);
    options(filter,[...STATUS].map(([key,[label]])=>({value:key,label:label+'（'+n(key)+'）'})),ctx.filter,'全部状态（'+tasks.length+'）');
    const present=new Set(), activeItems=new Set(), ordered=[...tasks].sort((a,b)=>(Date.parse(b.createdAt)||Number(b.createdAt)||0)-(Date.parse(a.createdAt)||Number(a.createdAt)||0));
    const nodes=ordered.map(t=>{
      present.add(t.id); list(t.items).forEach(it=>activeItems.add(pairKey(t.id,it.id)));
      if (!taskViews.has(t.id)) taskViews.set(t.id,createTask(ctx,t.id)); const v=taskViews.get(t.id);v.update(t);return v.node;
    });
    order(cards,nodes); for (const id of taskViews.keys()) if (!present.has(id)) taskViews.delete(id);
    blank.hidden=!!tasks.length && (!ctx.filter || n(ctx.filter)>0);
    cards.hidden=!blank.hidden; text(blankTitle,!ctx.loaded?'正在读取记录':tasks.length?'没有匹配的记录':'还没有任务');
    text(blankBody,!ctx.loaded?'连接后将在这里显示最新进度。':tasks.length?'换一个状态，或选择「全部状态」。':'提交任务后，在这里查看去向、进度和结果。');
    const lost=[];
    for (const [k,d] of memory.items) if (!activeItems.has(k)) {
      if (!hasItemDraft(d)) {memory.items.delete(k); continue;}
      lost.push([d.label,d.follow && '追问：'+d.follow,d.edited && '交接：'+d.handoff,d.sessionChoice && '候选会话：'+d.sessionChoice,d.dirChoice && '新建目录：'+d.dirChoice].filter(Boolean).join('\n'));
    }
    orphan.hidden=!lost.length; text(orphanText,lost.join('\n\n'));
  }
  function receive(payload) {
    if (disposed) return; const seq=++version;
    function fail(err) {if (!disposed && seq===version) {readError=errorMessage(err);paint();}}
    function apply(s) {
      if (disposed || seq!==version) return;
      if (!s || typeof s!=='object' || !('connected' in s)) {fail(new Error('宿主没有提供有效的状态快照'));return;}
      readError=''; ctx.loaded=true; ctx.state={settings:s.settings || {},tasks:list(s.tasks),workspaces:list(s.workspaces),catalog:list(s.catalog),sessions:list(s.sessions),connected:s.connected===true,notice:str(s.notice)};
      ctx.byTask=new Map(ctx.state.tasks.map(t=>[t.id,t])); ctx.models=catalogEntries(s.catalog); ctx.dirs=directoryOptions(s.settings?.projects,s.settings?.generalDir);
      ctx.sessions=new Map(list(s.sessions).map(x=>[x.id,x])); ctx.setupIssue=checkSettings(ctx.state.settings,ctx.models,ctx.state.catalog).error; ctx.ready=!ctx.setupIssue;
      if (chooseInitial && ctx.state.connected) {view=!ctx.ready && !ctx.state.tasks.length && !memory.compose ? 'settings' : 'board'; chooseInitial=false;}
      paint();
    }
    try {
      const snapshot=payload && typeof payload==='object' && 'connected' in payload ? payload : api.getState();
      if (typeof snapshot?.then==='function') Promise.resolve(snapshot).then(apply).catch(fail); else apply(snapshot);
    } catch (err) {fail(err);}
  }
  function guardReload(e) {
    if (memory.compose || memory.settings?.dirty || [...memory.items.values()].some(hasItemDraft)) {e.preventDefault();e.returnValue='';}
  }
  doc.defaultView?.addEventListener('beforeunload',guardReload);
  try { unsubscribe=api.subscribe(receive); } catch (err) {subError=errorMessage(err);}
  if (version===0) receive(); paint();
  return function dispose() {
    if (disposed) return; disposed=true;version++;ctx.cleanup.leave();ctx.pane.close();
    doc.defaultView?.removeEventListener('beforeunload',guardReload);
    try { if (typeof unsubscribe==='function') unsubscribe(); } finally {shell.remove();taskViews.clear();}
  };
}
