import { css } from './style.mjs';
import { STATUS, list, str, statusOf, pairKey, catalogEntries, directoryOptions, checkSettings, uiKit, text, val, msg, options, order, shortcut, errorMessage } from './shared.mjs';
import { createSettings } from './settings.mjs';
import { createTask, hasItemDraft } from './tasks.mjs';

// Unsaved text stays in memory. Verified hosts may share an object across remounts for one
// owner/DSH instance; unrelated controllers never inherit it. Nothing unsubmitted goes to storage.
const draftsByAPI = new WeakMap();
const empty = () => ({settings:{},tasks:[],workspaces:[],catalog:[],sessions:[],connected:false,notice:''});

/** Mount inside a dedicated DSH surface. No host registration, navigation or network side effects. */
export function mountRouter(root,api) {
  const doc=root.ownerDocument || document, ui=uiKit(doc), {el,button,field,live}=ui;
  const scope=api.draftScope && typeof api.draftScope==='object' ? api.draftScope : api;
  const memory=draftsByAPI.get(scope) || {compose:'',rev:0,settings:null,items:new Map()}; draftsByAPI.set(scope,memory);
  const pending=new Set(), taskViews=new Map();
  let disposed=false, unsubscribe, version=0, readError='', subError='', chooseInitial=true, view='board';
  const ctx={api,ui,memory,state:empty(),loaded:false,online:false,ready:false,filter:'',models:[],sessions:new Map(),dirs:[],
    busy:n=>pending.has(n),run,paint,markSettingsDirty,goBoard:()=>navigate('board')};
  const shell=el('div','dshr'); shell.setAttribute('lang','zh-CN');
  const sheet=el('style'); sheet.textContent=css;
  const wrap=el('div','rt-wrap'), header=el('header','rt-header'), brand=el('div','rt-brand'), mark=el('div','rt-mark','↗'); mark.setAttribute('aria-hidden','true');
  const identity=el('div'); identity.append(el('p','rt-eyebrow','DSH　/　个人工作区'),el('h1','','任务路由台')); brand.append(mark,identity);
  const tools=el('div','rt-tools'), online=el('span','rt-connection'); online.setAttribute('role','status');
  const refreshNotice=live(), refresh=button('刷新状态',()=>run(refreshNotice,'刷新状态',()=>api.refresh(),()=> '已刷新状态。',{offline:true}));
  tools.append(online,refresh); header.append(brand,tools);
  const nav=el('nav','rt-nav'); nav.setAttribute('aria-label','任务路由导航');
  const boardTab=button('任务台',()=>navigate('board'),'rt-nav-btn'), settingsTab=button('路由设置',()=>navigate('settings'),'rt-nav-btn'); nav.append(boardTab,settingsTab);
  const connection=live(), remoteNotice=live(), subscriptionNotice=live();
  const board=el('div','rt-board'), intro=el('div','rt-intro-grid'), composeBox=el('form','rt-compose rt-card'); composeBox.noValidate=true;
  const compose=el('textarea'), composerFeedback=live(); compose.rows=3; compose.placeholder='例如：检查网站项目的发布说明，再把结论交给文档项目整理。'; compose.value=memory.compose;
  const send=el('button','rt-btn rt-primary','提交任务'); send.type='submit';
  const composeFoot=el('div','rt-compose-foot'); composeFoot.append(el('span','rt-muted','⌘ / Ctrl + Enter 提交'),send);
  const setupWarning=el('div','rt-setup-warning'), setupReason=el('span');
  setupWarning.append(setupReason,button('去路由设置',()=>navigate('settings'),'rt-btn rt-quiet'));
  composeBox.append(el('p','rt-eyebrow','任务入口'),el('h2','','创建总任务'),el('p','rt-muted','可以跨多个项目。明确的子项先执行，需要选择和交接的子项单独等你处理。'),field('任务内容',compose),composeFoot,setupWarning,composerFeedback);
  compose.addEventListener('input',()=>{memory.compose=compose.value; memory.rev++;});
  composeBox.addEventListener('submit',e=>{e.preventDefault();submit();}); shortcut(compose,submit);
  const stats=el('section','rt-overview rt-card'), statsGrid=el('div','rt-stats'), metrics=[];
  for (const label of ['总任务','子项','待你处理','运行中']) {
    const b=el('div'), number=el('strong','','0'); b.append(number,el('span','rt-muted',label)); statsGrid.append(b); metrics.push(number);
  }
  const progressText=el('span','rt-label'), progress=el('progress'); progress.setAttribute('aria-label','所有任务已完成子项');
  stats.append(el('p','rt-eyebrow','进度概览'),el('h2','','任务进度'),statsGrid,progressText,progress); intro.append(composeBox,stats);
  const ledger=el('section','rt-ledger'), ledgerHead=el('div','rt-ledger-head'), filter=el('select');
  ledgerHead.append(el('h2','','任务记录'),field('按子项状态筛选',filter));
  filter.addEventListener('change',()=>{ctx.filter=filter.value;paint();});
  const cards=el('div','rt-task-list'), blank=el('div','rt-empty rt-card'), blankTitle=el('h3'), blankBody=el('p','rt-muted');
  blank.append(blankTitle,blankBody); ledger.append(ledgerHead,blank,cards);
  const orphan=el('section','rt-card rt-orphan'), orphanText=el('pre','rt-user-text');
  orphan.append(el('h3','','已离开列表的草稿'),el('p','rt-muted','这些子项已不在当前快照。未提交的内容仍可复制，不会发送到其他子项。'),orphanText);
  board.append(intro,ledger,orphan);
  const settings=createSettings(ctx); wrap.append(header,nav,connection,subscriptionNotice,remoteNotice,refreshNotice,board,settings.node); shell.append(sheet,wrap); root.append(shell);

  function navigate(to) {if (!disposed) {view=to;chooseInitial=false;paint();}}
  function markSettingsDirty() {text(settingsTab,'路由设置'+(memory.settings?.dirty?' · 未保存':''));}
  function submit() {
    if (!ctx.online || !ctx.ready || pending.has(composerFeedback)) return;
    const value=compose.value, rev=memory.rev;
    if (!value.trim()) {msg(composerFeedback,'请先填写任务内容。','red'); compose.focus(); return;}
    run(composerFeedback,'提交任务',()=>api.submit(value),()=>{
      if (rev===memory.rev) {memory.compose=''; val(compose,'');}
      return '总任务已提交，可在任务记录查看分项进度。';
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
      msg(slot,accepted?.() || (label+'成功。'),'green'); receive();
    } catch (error) {
      if (!disposed) msg(slot,label+'失败：'+errorMessage(error),'red');
    } finally {pending.delete(slot); if (!disposed) paint();}
  }
  function paint() {
    if (disposed) return;
    ctx.online=ctx.loaded && ctx.state.connected && !readError;
    text(online,readError?'状态不可用':!ctx.loaded?'正在连接':ctx.online?'已连接':'未连接'); online.setAttribute('data-on',String(ctx.online));
    msg(connection,readError ? '读取入口状态失败：'+readError+'。可刷新重试，现有草稿已保留。'
      : !ctx.loaded ? '正在读取任务、目录和模型…' : !ctx.online ? '未连接到 DSH。显示的是上次已知状态；仍可编辑草稿，恢复连接后再发送。' : '',readError?'red':'amber');
    msg(subscriptionNotice,subError ? '实时更新不可用：'+subError+'。请使用「刷新状态」。' : '','amber');
    msg(remoteNotice,ctx.state.notice,/(授权|失败|错误|forbidden|unauthorized|error)/i.test(ctx.state.notice)?'red':'info');
    refresh.disabled=pending.has(refreshNotice); text(refresh,refresh.disabled?'正在刷新…':'刷新状态');
    board.hidden=view!=='board'; settings.node.hidden=view!=='settings';
    boardTab.setAttribute('aria-pressed',String(!board.hidden)); settingsTab.setAttribute('aria-pressed',String(!settings.node.hidden));
    settings.update(); markSettingsDirty();
    send.disabled=!ctx.online || !ctx.ready || pending.has(composerFeedback); text(send,pending.has(composerFeedback)?'正在提交…':'提交任务');
    setupWarning.hidden=!ctx.loaded || ctx.ready; text(setupReason,'路由尚未就绪：'+(ctx.setupIssue || '请完成设置。'));
    const tasks=ctx.state.tasks, all=tasks.flatMap(t=>list(t.items)), counts=new Map();
    for (const it of all) {const s=statusOf(it);counts.set(s,(counts.get(s)||0)+1);}
    const n=s=>counts.get(s)||0, total=all.length, done=n('done');
    [tasks.length,total,n('clarify')+n('handoff')+n('input-required'),n('running')].forEach((v,i)=>text(metrics[i],v));
    text(progressText,done+' / '+total+' 项已完成'); progress.max=Math.max(total,1); progress.value=done;
    options(filter,[...STATUS].map(([key,[label]])=>({value:key,label:label+'（'+n(key)+'）'})),ctx.filter,'全部状态（'+total+'）');
    const present=new Set(), activeItems=new Set(), ordered=[...tasks].sort((a,b)=>(Date.parse(b.createdAt)||Number(b.createdAt)||0)-(Date.parse(a.createdAt)||Number(a.createdAt)||0));
    const nodes=ordered.map(t=>{
      present.add(t.id); list(t.items).forEach(it=>activeItems.add(pairKey(t.id,it.id)));
      if (!taskViews.has(t.id)) taskViews.set(t.id,createTask(ctx,t.id)); const v=taskViews.get(t.id);v.update(t);return v.node;
    });
    order(cards,nodes); for (const id of taskViews.keys()) if (!present.has(id)) taskViews.delete(id);
    blank.hidden=!!tasks.length && (!ctx.filter || n(ctx.filter)>0);
    text(blankTitle,!ctx.loaded?'正在读取记录':tasks.length?'没有匹配的子项':'还没有任务');
    text(blankBody,!ctx.loaded?'连接后将在这里显示最新进度。':tasks.length?'换一个状态，或选择「全部状态」。':'提交第一条任务后，在这里跟踪每个去向、依赖与结果。');
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
      ctx.models=catalogEntries(s.catalog); ctx.dirs=directoryOptions(s.settings?.projects,s.settings?.generalDir);
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
    if (disposed) return; disposed=true;version++;
    doc.defaultView?.removeEventListener('beforeunload',guardReload);
    try { if (typeof unsubscribe==='function') unsubscribe(); } finally {shell.remove();taskViews.clear();}
  };
}
