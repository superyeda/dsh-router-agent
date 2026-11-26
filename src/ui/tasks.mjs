import { TIERS, STATUS, SESSION_MODES, modelLabel, str, list, statusOf, matchesFilter, recordStatus, recordCaption, candidateAt, pairKey, options, text, val, msg, order, shortcut } from './shared.mjs';
import { canRemoveTask } from '../core/record-policy.mjs';

import { createEmptyRecovery } from './recovery.mjs';

export const hasItemDraft = d => !!(d.follow || d.edited || d.sessionChoice || d.dirChoice);
const when = new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function dateLabel(value) {
  if (value == null || value === '') return '';
  const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : when.format(date);
}
function withStale(rows,value) {
  return value && !rows.some(r=>r.value===value) ? [...rows,{value,label:value+'（不再可选）',disabled:true}] : rows;
}

function createItem(ctx, taskId, id) {
  const {el,button,field,live}=ctx.ui, key=pairKey(taskId,id);
  const draft=ctx.memory.items.get(key) || {follow:'',followRev:0,handoff:'',base:'',edited:false,handoffRev:0,sessionChoice:'',dirChoice:''};
  ctx.memory.items.set(key,draft);
  const card=el('article','rt-item'), top=el('div','rt-item-top'), no=el('span','rt-index'), badge=el('span','rt-badge');
  const title=el('h4','rt-user-text'), facts=el('dl','rt-facts'), reason=el('p','rt-reason'), relation=el('p','rt-muted');
  const project=el('dd'), tier=el('dd'), session=el('dd'), decision=el('dd');
  for (const [name,dd] of [['目标目录',project],['路由方式',decision],['路由档位',tier],['关联会话',session]]) {
    const group=el('div'); group.append(el('dt','',name),dd); facts.append(group);
  }
  const runtime=el('dl','rt-runtime'), modelKey=el('dt','rt-label'), modelValue=el('dd'), modeValue=el('dd');
  for (const [dt,dd] of [[modelKey,modelValue],[el('dt','rt-label','新会话创建预设'),modeValue]]) {const group=el('div');group.append(dt,dd);runtime.append(group);}
  const instruction=el('p','rt-instruction'), fault=el('p','rt-msg'), feedback=live(); fault.setAttribute('data-tone','red');
  const result=el('details','rt-result'), resultText=el('pre','rt-user-text'); result.append(el('summary','','查看结果'),resultText);
  const savedHandoff=el('details','rt-result'), savedLabel=el('summary'), savedText=el('pre','rt-user-text'); savedHandoff.append(savedLabel,savedText);
  const route=el('details','rt-route'); route.append(el('summary','','路由详情'),facts,runtime,reason);
  let item=null, task=null, index=0;
  const unavailable=()=>!ctx.online || ctx.busy(feedback);
  const retryable=()=>['failed','unknown'].includes(item?.status) && item.retryable===true && item.recoverableEmpty!==true && typeof ctx.api.retry==='function';
  const canFollow=()=>!!item?.sessionId && item.status!=='input-required' && (item.accepted ?? ['queued','running','done','failed'].includes(item.status));
  const inState=state=>list(list(state?.tasks).find(t=>t.id===taskId)?.items).find(i=>i.id===id);
  const canReview=i=>i?.status==='clarify' && (!i.decision || i.decision==='clarify') && !i.sessionId && !i.attempted && !i.accepted && !i.configured && (i.dependsOn==null || (Array.isArray(i.dependsOn) && i.dependsOn.length===0));
  let editVersion=0;
  function recommended(state,hint) {
    const i=inState(state),p=i?.project;
    if (!state?.connected || !canReview(i) || !p || !(state.settings?.generalDir===p || list(state.settings?.projects).some(d=>d.path===p))) return null;
    if (hint?.kind==='create' && hint.project===p) return {kind:'create',project:p};
    if (hint?.kind==='reuse' && hint.sessionId && list(i.candidates).includes(hint.sessionId) && list(state.sessions).some(s=>s.id===hint.sessionId && s.cwd===p)) return {kind:'reuse',sessionId:hint.sessionId,project:p};
    return null;
  }
  const stillValid=(state,r)=>!!r && recommended(state,r)?.project===r.project;
  function forgetSuggestion() {
    const prev=draft.routeSuggestion;
    if (prev?.kind==='reuse' && draft.sessionChoice===prev.sessionId) draft.sessionChoice='';
    if (prev?.kind==='create' && draft.dirChoice===prev.project) draft.dirChoice='';
    draft.routeSuggestion=null;
  }
  function reviewRoute() {
    if (!canReview(inState(ctx.state)) || unavailable() || typeof ctx.api.reviewRoute!=='function') return;
    const rev=editVersion;let hint, state, observed;
    ctx.run(feedback,'重新匹配此项',async()=>{
      hint=await ctx.api.reviewRoute(taskId,id);if(hint?.ok===false)return hint;
      observed=ctx.state;state=await ctx.api.getState();
    },()=>{
      if(editVersion!==rev) return '已重新匹配，未发送。保留了你刚刚手选的去向，请核对后再确认。';
      forgetSuggestion();
      const r=recommended(state,hint);
      if(!r || !ctx.online || !canReview(inState(ctx.state)) || (ctx.state!==observed && !stillValid(ctx.state,r))) return hint?'匹配结果已变化，未预选、未发送。请核对候选或再次匹配。':'仍没有唯一推荐，未发送。请手动选择候选会话或目标目录。';
      draft.routeSuggestion=r;
      if(r.kind==='reuse') {draft.sessionChoice=r.sessionId;return '已预选候选会话 '+r.sessionId+'，尚未发送。请核对后点「使用此会话」。';}
      draft.dirChoice=r.project;return '已预选目录 '+r.project+'，尚未新建或发送。请核对后点「在此新建」。';
    });
  }
  async function resolveChoice(kind) {
    if (!item || statusOf(item)!=='clarify' || unavailable()) return;
    const chosen=kind==='reuse' ? draft.sessionChoice : draft.dirChoice;
    if (!chosen || (kind==='reuse' ? !candidateAt(item,chosen,ctx.sessions.get(chosen)?.cwd,true) : !ctx.dirs.some(d=>d.value===chosen))) {
      msg(feedback,kind==='reuse'?'请选择仍有效的候选会话。':'请先从配置中选择目标目录。','red'); return;
    }
    const choice=kind==='reuse'?{kind,sessionId:chosen}:{kind,project:chosen};
    const before=[draft.sessionChoice,draft.dirChoice];
    const suggestion=draft.routeSuggestion?.kind===kind?draft.routeSuggestion:null,rev=editVersion;
    await ctx.run(feedback,'确定路由',async()=>{
      if (suggestion) {
        const current=await ctx.api.getState();
        if(card.isConnected===false || !ctx.online || rev!==editVersion || !stillValid(ctx.state,suggestion) || !stillValid(current,suggestion)) throw Error('推荐目标已变化，未发送。请重新匹配或手动选择。');
      }
      return ctx.api.resolve(taskId,id,choice);
    },()=>{
      if(draft.routeSuggestion===suggestion) draft.routeSuggestion=null;
      if (draft.sessionChoice===before[0]) draft.sessionChoice='';
      if (draft.dirChoice===before[1]) draft.dirChoice='';
      return '已提交路由选择。';
    });
  }
  const choices=el('div','rt-action-box'); choices.append(el('h5','','选择目的地'),el('p','rt-muted','查看候选不会发送内容；确认后只投递到所选的一个会话。'));
  const reuse=el('select'), create=el('select'), reuseRow=el('div','rt-choice-row'), createRow=el('div','rt-choice-row');
  const use=button('使用此会话',()=>resolveChoice('reuse')), newSession=button('在此新建',()=>resolveChoice('create'));
  const peek=button('在侧栏查看候选会话',()=>ctx.pane.open(ref(draft.sessionChoice,'candidate'),peek),'rt-btn rt-quiet');
  const noCandidates=el('p','rt-muted','没有候选会话，请选择目录新建。');
  reuseRow.append(field('复用候选会话',reuse),use,peek); createRow.append(field('在项目或通用目录新建会话',create),newSession);
  const review=button('重新匹配此项（不发送）',reviewRoute);
  const reviewInfo=el('p','rt-muted','按当前设置重新分类，可能调用意图模型。不会新建会话，也不会把此项发送到执行会话。');
  const staleRecommendation=el('p','rt-muted','上次推荐已经失效。请重新匹配或手动选择当前有效的去向。');
  choices.append(review,reviewInfo,noCandidates,reuseRow,createRow,staleRecommendation);
  reuse.addEventListener('change',()=>{editVersion++;if(draft.routeSuggestion?.kind==='reuse') draft.routeSuggestion=null;draft.sessionChoice=reuse.value;update(item,task,index);});
  create.addEventListener('change',()=>{editVersion++;if(draft.routeSuggestion?.kind==='create') draft.routeSuggestion=null;draft.dirChoice=create.value;update(item,task,index);});
  const transfer=el('div','rt-action-box'), handoff=el('textarea'), hInfo=el('p','rt-muted'); handoff.rows=5;
  const approve=button('批准并发送交接',sendHandoff,'rt-btn rt-primary');
  const latest=button('载入最新交接预览',()=>{draft.edited=false; draft.handoffRev++; update(item,task,index);},'rt-btn rt-quiet');
  const hActions=el('div','rt-actions'); hActions.append(approve,latest);
  transfer.append(el('h5','','交接预览'),hInfo,field('将发往目标会话的内容（可编辑）',handoff),hActions);
  handoff.addEventListener('input',()=>{draft.handoff=handoff.value; draft.edited=true; draft.handoffRev++;});
  function sendHandoff() {
    if (!item || statusOf(item)!=='handoff' || unavailable()) return;
    const value=handoff.value, rev=draft.handoffRev;
    if (!value.trim()) {msg(feedback,'交接内容不能为空。','red'); handoff.focus();return;}
    ctx.run(feedback,'发送交接',()=>ctx.api.approve(taskId,id,value),()=>{
      if (draft.handoffRev===rev) draft.edited=false;
      return '已批准将预览内容交给此项；DSH 权限审批仍由原会话处理。';
    });
  }
  const followPanel=el('details','rt-follow'), follow=el('textarea'); follow.rows=2; follow.placeholder='补充要求、提出问题，或请它继续…';
  followPanel.open=!!draft.follow; const followNote=el('p','rt-muted');
  const post=button('发送追问',sendFollow,'rt-btn rt-primary');
  followPanel.append(el('summary','','追问原会话'),followNote,field('仅发往关联会话的追问',follow),post);
  follow.addEventListener('input',()=>{draft.follow=follow.value; draft.followRev++;}); shortcut(follow,sendFollow);
  function sendFollow() {
    if (!canFollow() || unavailable()) return;
    const value=follow.value, rev=draft.followRev;
    if (!value.trim()) {msg(feedback,'请先填写这项的追问。','red'); follow.focus(); return;}
    ctx.run(feedback,'发送追问',()=>ctx.api.followUp(taskId,id,value),()=>{
      if (draft.followRev===rev) {draft.follow=''; val(follow,'');}
      return '已提交本项追问。';
    });
  }
  const ref=(sid,kind='bound')=>({taskId,itemId:id,sid,kind});
  const actions=el('div','rt-actions'), jump=button('在侧栏查看原会话',()=>ctx.pane.open(ref(item?.sessionId),jump));
  const retry=button('重试此项',()=>{
    if (retryable()) ctx.run(feedback,'重试此项',()=>ctx.api.retry(taskId,id),()=> '已提交重试。');
  });
  const recovery=createEmptyRecovery(ctx,taskId,id,feedback);
  actions.append(jump,retry); top.append(no,badge); card.append(top,title,relation,instruction,fault,choices,transfer,recovery.node,actions,route,savedHandoff,result,followPanel,feedback);
  function update(next, owner, pos) {
    item=next; task=owner; index=pos; draft.label=str(item.text) || '未命名任务';
    const status=statusOf(item), [label,tone]=STATUS.get(status), bound=ctx.sessions.get(item.sessionId);
    const children=list(task.items), parts=children.filter(i=>!i.parentItemId), follows=children.filter(i=>i.parentItemId);
    function itemName(i) {return i.parentItemId?'追问 '+(follows.indexOf(i)+1):parts.length>1?'历史分项 '+(parts.indexOf(i)+1):'原任务';}
    text(no,itemName(item)); text(badge,label); badge.setAttribute('data-tone',tone); card.setAttribute('data-status',status); card.setAttribute('data-item-id',id);
    // task.text is shown in full once above the routing facts. Preserve differing legacy text.
    title.hidden=!item.parentItemId && parts.length===1 && item.text===task.text; text(title,title.hidden?'':item.text || '未命名任务');
    top.hidden=children.length===1;
    text(project,item.project || bound?.cwd || '尚待明确');
    const band=TIERS.find(([k])=>k===item.tier)?.[1] || item.tier || '尚待明确';
    const isReuse=item.decision==='reuse' || !!item.parentItemId;
    text(decision,isReuse?'复用原会话':item.decision==='create'?'新建会话':item.decision==='clarify'?'待选择':'未记录');
    text(tier,isReuse?'沿用原会话模型与模式':band);runtime.hidden=isReuse || item.decision!=='create';
    if (!runtime.hidden) {
      const valid=t=>typeof t?.provider==='string' && !!t.provider.trim() && typeof t.model==='string' && !!t.model.trim();
      const planned=valid(item.selection)?item.selection:null;
      const applied=item.configured===true ? (valid(item.appliedSelection)?item.appliedSelection:planned) : null;
      text(modelKey,applied?'创建时已配置 · 宿主已确认':'计划模型 · 尚无配置确认');
      text(modelValue,applied?modelLabel(applied):planned?modelLabel(planned):'未记录完整模型信息');
      text(modeValue,item.agentPreset ? '请求的预设：'+(SESSION_MODES.get(item.agentPreset) || item.agentPreset)
        : item.sessionMode==='inherit'?'跟随 DSH 默认（未记录具体预设）'
        : SESSION_MODES.has(item.sessionMode)?'计划使用：'+SESSION_MODES.get(item.sessionMode):'未记录创建预设，无法推断当前模式');
    }
    text(session,item.sessionId ? [bound?.title!==item.sessionId && bound?.title,item.sessionId].filter(Boolean).join(' · ') : '尚未关联');
    text(reason,'路由依据：'+(item.reason || '尚无说明。'));
    const referenced=refId=>{const i=children.find(it=>it.id===refId); return i ? itemName(i) : str(refId);};
    const relations=[]; if (item.parentItemId) relations.push('追问来源：'+referenced(item.parentItemId));
    if (list(item.dependsOn).length) relations.push('依赖：'+item.dependsOn.map(referenced).join('、'));
    relation.hidden=!relations.length; text(relation,relations.join('　·　'));
    const help={ 'input-required':item.sessionId ? '请在原会话中输入或审批；可用时可在侧栏处理。任务路由台不会代批权限。' : '需要原会话处理，尚未取得会话 ID。请刷新核对，不要重复派发。',
      'unknown':'无法确认这项是否仍在执行。请先核对原会话，不要重复派发。', 'waiting':'前置子项尚未就绪，暂不派发。' }[status];
    instruction.hidden=!help; text(instruction,help);
    const error=str(item.error) || (status==='failed'?'未提供失败原因，请核对原会话或刷新状态。':'');
    fault.hidden=!error; text(fault,error ? '异常：'+error : ''); result.hidden=!item.result; text(resultText,item.result);
    choices.hidden=status!=='clarify';review.hidden=reviewInfo.hidden=!canReview(item) || typeof ctx.api.reviewRoute!=='function';review.disabled=unavailable();
    if (!choices.hidden) {
      const candidates=[...new Set(list(item.candidates))];
      const rows=candidates.map(sid=>{const s=ctx.sessions.get(sid); return {value:sid,label:s ? (s.title || sid)+' · '+(s.busy?'忙碌':'空闲')+' · '+(s.cwd || sid)+(s.updatedAt?' · '+dateLabel(s.updatedAt):'')+' · '+sid : sid+'（资料未同步）'};});
      options(reuse,withStale(rows,draft.sessionChoice),draft.sessionChoice,'选择候选会话…');
      options(create,withStale(ctx.dirs,draft.dirChoice),draft.dirChoice,'选择目标目录…');
      reuseRow.hidden=!rows.length && !draft.sessionChoice; noCandidates.hidden=!!rows.length;
      text(noCandidates,review.hidden?'没有候选会话，请选择目录新建。':'当前记录没有候选。可先重新匹配，也可自行选择目录新建。');
      use.disabled=unavailable() || !candidateAt(item,draft.sessionChoice,ctx.sessions.get(draft.sessionChoice)?.cwd,true); peek.disabled=!ctx.pane.target(ref(draft.sessionChoice,'candidate'));
      newSession.disabled=unavailable() || !ctx.dirs.some(d=>d.value===draft.dirChoice);
      staleRecommendation.hidden=!draft.routeSuggestion || stillValid(ctx.state,draft.routeSuggestion);
      if (!staleRecommendation.hidden) {
        if (draft.routeSuggestion.kind==='reuse') use.disabled=true; else newSession.disabled=true;
      }
    }
    const remote=str(item.handoff); savedHandoff.hidden=status==='handoff' || !remote;
    text(savedLabel,item.approved?'已确认的交接内容':'已记录的交接预览（未确认）'); text(savedText,savedHandoff.hidden?'':remote);
    transfer.hidden=status!=='handoff' && !draft.edited;
    if (!transfer.hidden) {
      if (!draft.edited) {draft.handoff=draft.base=remote;}
      val(handoff,draft.handoff); latest.hidden=!draft.edited || remote===draft.base || status!=='handoff';
      text(hInfo,status!=='handoff'?'子项已离开交接阶段。未发送的编辑保留在下方，可复制；不会再次发送。'
        : !latest.hidden?'上游预览有更新。已保留你的编辑；请核对，或载入最新预览后再批准。'
        :'请核对下方内容。只有批准后才会发送；这不是 DSH 工具权限审批。');
      approve.disabled=unavailable() || status!=='handoff'; approve.hidden=status!=='handoff';
    }
    recovery.update(item);
    jump.hidden=!item.sessionId; jump.disabled=!ctx.pane.target(ref(item.sessionId));
    jump.title=jump.disabled?'尚未确认此会话仍在当前许可范围，请刷新。':'留在任务台查看原会话';
    retry.hidden=!retryable(); retry.disabled=unavailable();
    actions.hidden=jump.hidden && retry.hidden; followPanel.hidden=!canFollow() && !draft.follow;
    val(follow,draft.follow); post.disabled=unavailable() || !canFollow();
    text(followNote,status==='input-required'?'先到原会话完成输入或审批。草稿可继续编辑，但不能代替原会话的答复。'
      : canFollow()?'只发送到上方关联的原会话，不另建任务或重新路由。':'未确认原会话已接收这项，当前不能发送追问。');
    card.hidden=!!ctx.filter && ctx.filter!==status;
  }
  return {node:card,update};
}

// A legacy record can point at several sessions. Open directly only if the target is
// unambiguous; otherwise its details retain a separate control for each original item.
function primarySession(ctx, task) {
  const targets=new Map(), active=new Map();
  for (const i of list(task.items)) {
    if (!i.sessionId || (ctx.filter && statusOf(i)!==ctx.filter)) continue;
    const ref={taskId:task.id,itemId:i.id,kind:'bound',sid:i.sessionId};
    if (!ctx.pane.target(ref)) continue;
    targets.set(ref.sid,ref);
    if (['running','queued','dispatching','input-required'].includes(i.status)) active.set(ref.sid,ref);
  }
  const pool=active.size ? active : targets;
  return pool.size===1 ? pool.values().next().value : null;
}

let detailSerial=0;
export function createTask(ctx,id) {
  const {el,button}=ctx.ui, node=el('section','rt-task'), row=el('div','rt-record-row'); node.setAttribute('data-task-id',id);
  let current, target=null, expanded=false;
  const select=button('',()=>{if(target) ctx.pane.open(target,select); else toggle();},'rt-record-select');
  const title=el('span','rt-record-title'), meta=el('span','rt-record-meta'), time=el('time'), badge=el('span','rt-badge'), info=el('span','rt-record-info');
  meta.append(badge,time,info); select.append(title,meta);
  const toggleButton=button('展开详情',toggle,'rt-btn rt-quiet rt-record-toggle'); row.append(select,toggleButton);
  const detail=el('div','rt-record-details'), original=el('p','rt-full-text rt-user-text'), itemsBox=el('div','rt-items'), items=new Map();
  detail.id='rt-task-detail-'+(++detailSerial); toggleButton.setAttribute('aria-controls',detail.id);
  const admin=el('div','rt-record-admin'), remove=button('删除记录',()=>ctx.cleanup.askOne(id,admin,remove),'rt-btn rt-danger'), policy=el('span','rt-muted'); admin.append(remove,policy);
  const empty=el('p','rt-muted','尚未记录路由或投递状态。');
  detail.append(el('p','rt-label','任务原文'),original,itemsBox,empty,admin); node.append(row,detail);
  function toggle() {
    if (!current || node.hidden) return;
    expanded=!expanded; if (!expanded) ctx.cleanup.leave(id); update(current);
  }
  function update(task) {
    current=task; node.hidden=!matchesFilter(task,ctx.filter);
    const children=list(task.items), status=recordStatus(task);
    const [label,tone]=STATUS.get(status), caption=recordCaption(task), stamp=dateLabel(task.createdAt);
    text(title,caption); text(badge,label); badge.setAttribute('data-tone',tone); node.setAttribute('data-status',status);
    text(time,stamp || '时间未记录'); if(stamp) {const date=new Date(task.createdAt); time.setAttribute('datetime',date.toISOString()); time.title=date.toLocaleString();}
    else {time.removeAttribute('datetime'); time.title='';}
    const notes=[], roots=children.filter(i=>!i.parentItemId), follows=children.length-roots.length;
    if(ctx.filter && !node.hidden && ctx.filter!==status) notes.push('含'+STATUS.get(ctx.filter)[0]+'项');
    if(children.some(i=>i.recoverableEmpty===true)) notes.push('可核对空会话恢复');
    if(roots.length>1) notes.push(roots.length+' 个历史分项');
    if(follows) notes.push(follows+' 条追问');
    if(children.length>1) notes.push(children.filter(i=>i.status==='done').length+'/'+children.length+' 已完成');
    if(children.some(i=>ctx.memory.items.has(pairKey(id,i.id)) && hasItemDraft(ctx.memory.items.get(pairKey(id,i.id))))) notes.push('有草稿');
    target=node.hidden?null:primarySession(ctx,task); if(target) notes.push('查看会话 ›');
    text(info,notes.join(' · ')); info.hidden=!notes.length;
    select.setAttribute('data-action',target?'view-session':'view-details'); select.setAttribute('aria-label',(target?'在侧栏查看原会话：':expanded?'收起任务详情：':'查看任务详情：')+caption+'（'+[label,stamp,...notes.filter(n=>n!=='查看会话 ›')].filter(Boolean).join('，')+'）');
    select.setAttribute('aria-expanded',String(target ? ctx.pane.selected(id) : expanded));
    select.setAttribute('aria-controls',target ? ctx.pane.node.id : detail.id);
    node.setAttribute('data-selected',String(ctx.pane.selected(id))); text(toggleButton,expanded?'收起详情':'展开详情'); toggleButton.setAttribute('aria-expanded',String(expanded));
    detail.hidden=!expanded;
    // Do not build forms for a whole archive just to paint two lines per record.
    if (!expanded && !items.size) return;
    text(original,task.text || '（未记录原文）'); empty.hidden=!!children.length;
    const present=new Set(); const nodes=children.map((item,i)=>{
      present.add(item.id); if (!items.has(item.id)) items.set(item.id,createItem(ctx,id,item.id));
      const view=items.get(item.id); view.update(item,task,i); return view.node;
    });
    order(itemsBox,nodes); for (const key of items.keys()) if (!present.has(key)) items.delete(key);
    const eligible=canRemoveTask(task); remove.disabled=!eligible || !ctx.cleanup.canAsk() || typeof ctx.api.removeTask!=='function';
    text(policy,eligible?'只删除本机路由记录，保留原会话及其消息。':'这条记录仍需跟踪投递、交接或恢复状态，不能删除。');
  }
  return {node,update};
}
