import { TIERS, STATUS, SESSION_MODES, modelLabel, str, list, statusOf, pairKey, options, text, val, msg, order, shortcut } from './shared.mjs';

import { createEmptyRecovery } from './recovery.mjs';

export const hasItemDraft = d => !!(d.follow || d.edited || d.sessionChoice || d.dirChoice);
const when = new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
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
  const project=el('dd'), tier=el('dd'), session=el('dd');
  for (const [name,dd] of [['目标目录',project],['路由档位',tier],['关联会话',session]]) {
    const group=el('div'); group.append(el('dt','',name),dd); facts.append(group);
  }
  const runtime=el('dl','rt-runtime'), modelKey=el('dt','rt-label'), modelValue=el('dd'), modeValue=el('dd');
  for (const [dt,dd] of [[modelKey,modelValue],[el('dt','rt-label','新会话创建预设'),modeValue]]) {const group=el('div');group.append(dt,dd);runtime.append(group);}
  const instruction=el('p','rt-instruction'), fault=el('p','rt-msg'), feedback=live(); fault.setAttribute('data-tone','red');
  const result=el('details','rt-result'), resultText=el('pre','rt-user-text'); result.append(el('summary','','查看结果'),resultText);
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
    if (!chosen || (kind==='reuse' ? !list(item.candidates).includes(chosen) : !ctx.dirs.some(d=>d.value===chosen))) {
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
      return '已提交这项的路由选择。';
    });
  }
  const choices=el('div','rt-action-box'); choices.append(el('h5','','选择此项的目的地'),el('p','rt-muted','只影响当前子项，其他已明确的子项会先走。'));
  const reuse=el('select'), create=el('select'), reuseRow=el('div','rt-choice-row'), createRow=el('div','rt-choice-row');
  const use=button('使用此会话',()=>resolveChoice('reuse')), newSession=button('在此新建',()=>resolveChoice('create'));
  const peek=button('查看候选会话 ↗',()=>{if (list(item?.candidates).includes(draft.sessionChoice)) open(draft.sessionChoice);},'rt-btn rt-quiet');
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
  const post=button('发送此项追问',sendFollow,'rt-btn rt-primary');
  followPanel.append(el('summary','','追问此项'),followNote,field('仅发往本项关联会话的追问',follow),post);
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
  function open(sid) { if (sid) ctx.run(feedback,'打开会话',()=>ctx.api.openSession(sid),()=> '已请求打开原会话。',{offline:true}); }
  const actions=el('div','rt-actions'), jump=button('打开原会话 ↗',()=>open(item?.sessionId));
  const retry=button('重试此项',()=>{
    if (retryable()) ctx.run(feedback,'重试此项',()=>ctx.api.retry(taskId,id),()=> '已提交重试。');
  });
  const recovery=createEmptyRecovery(ctx,taskId,id,feedback);
  actions.append(jump,retry); top.append(no,badge); card.append(top,title,facts,runtime,reason,relation,instruction,fault,result,choices,transfer,recovery.node,actions,followPanel,feedback);
  function update(next, owner, pos) {
    item=next; task=owner; index=pos; draft.label=str(item.text) || '未命名子项';
    const status=statusOf(item), [label,tone]=STATUS.get(status), bound=ctx.sessions.get(item.sessionId);
    text(no,'子项 '+String(pos+1).padStart(2,'0')); text(badge,label); badge.setAttribute('data-tone',tone); card.setAttribute('data-status',status);
    text(title,item.text || '未命名子项');
    text(project,item.project || bound?.cwd || '尚待明确');
    const band=TIERS.find(([k])=>k===item.tier)?.[1] || item.tier || '尚待明确';
    const isReuse=item.decision==='reuse' || !!item.parentItemId;
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
    text(session,item.sessionId ? (bound?.title || item.sessionId) : '尚未关联');
    text(reason,'路由依据：'+(item.reason || '尚无说明。'));
    const ref=refId=>{const i=list(task.items).findIndex(it=>it.id===refId); return i<0 ? str(refId) : '子项 '+String(i+1).padStart(2,'0');};
    const relations=[]; if (item.parentItemId) relations.push('追问来源：'+ref(item.parentItemId));
    if (list(item.dependsOn).length) relations.push('依赖：'+item.dependsOn.map(ref).join('、'));
    relation.hidden=!relations.length; text(relation,relations.join('　·　'));
    const help={ 'input-required':item.sessionId ? '需要你前往原会话输入或审批。此入口不会代批权限。' : '需要原会话处理，尚未取得会话 ID。请刷新核对，不要重复派发。',
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
      use.disabled=unavailable() || !candidates.includes(draft.sessionChoice); peek.disabled=ctx.busy(feedback) || !candidates.includes(draft.sessionChoice);
      newSession.disabled=unavailable() || !ctx.dirs.some(d=>d.value===draft.dirChoice);
      staleRecommendation.hidden=!draft.routeSuggestion || stillValid(ctx.state,draft.routeSuggestion);
      if (!staleRecommendation.hidden) {
        if (draft.routeSuggestion.kind==='reuse') use.disabled=true; else newSession.disabled=true;
      }
    }
    const remote=str(item.handoff);
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
    jump.hidden=!item.sessionId; jump.disabled=ctx.busy(feedback);
    retry.hidden=!retryable(); retry.disabled=unavailable();
    actions.hidden=jump.hidden && retry.hidden; followPanel.hidden=!canFollow() && !draft.follow;
    val(follow,draft.follow); post.disabled=unavailable() || !canFollow();
    text(followNote,status==='input-required'?'先到原会话完成输入或审批。草稿可继续编辑，但不能代替原会话的答复。'
      : canFollow()?'关联到此子项，不会作为新的总任务重新选择目的地。':'未确认原会话已接收这项，当前不能发送追问。');
    card.hidden=!!ctx.filter && ctx.filter!==status;
  }
  return {node:card,update};
}

export function createTask(ctx,id) {
  const {el}=ctx.ui, node=el('section','rt-task rt-card'), head=el('div','rt-task-head'), left=el('div'), right=el('div','rt-progress-box');
  const stamp=el('p','rt-eyebrow'), title=el('h3','rt-user-text'), count=el('span','rt-label'), bar=el('progress'); bar.setAttribute('aria-label','此任务已完成子项');
  const itemsBox=el('div','rt-items'), items=new Map(), empty=el('p','rt-muted','任务已记录，尚无子项。');
  left.append(stamp,title); right.append(count,bar); head.append(left,right); node.append(head,empty,itemsBox);
  function update(task) {
    const children=list(task.items), done=children.filter(i=>i.status==='done').length, stampText=dateLabel(task.createdAt);
    text(stamp,'总任务'+(stampText?'　/　'+stampText:'')); text(title,task.text || '未命名任务');
    text(count,done+' / '+children.length+' 项已完成'); bar.max=Math.max(children.length,1); bar.value=done;
    empty.hidden=!!children.length;
    const present=new Set(); const nodes=children.map((item,i)=>{
      present.add(item.id); if (!items.has(item.id)) items.set(item.id,createItem(ctx,id,item.id));
      const view=items.get(item.id); view.update(item,task,i); return view.node;
    });
    order(itemsBox,nodes); for (const key of items.keys()) if (!present.has(key)) items.delete(key);
    node.hidden=!!ctx.filter && !children.some(it=>statusOf(it)===ctx.filter);
  }
  return {node,update};
}
