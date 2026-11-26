import { list, msg, text } from './shared.mjs';

// This is a confirmation for ONE previously reserved session, not an alternate create/retry.
// Never derive its identity from a directory, title, candidate, sessionId, or error message.
export function createEmptyRecovery(ctx, taskId, itemId, feedback) {
  const {el,button}=ctx.ui;
  const node=el('section','rt-action-box'), preview=el('div'), facts=el('dl','rt-facts');
  const project=el('dd','rt-user-text'), id=el('dd','rt-user-text'), note=el('p','rt-muted');
  for (const [name,value] of [['原目标目录',project],['预期会话 ID',id]]) {
    const group=el('div'); group.append(el('dt','',name),value); facts.append(group);
  }
  const toggle=button('预览空会话恢复',togglePreview);
  const confirm=button('确认恢复并仅投递此项',send,'rt-btn rt-primary');
  preview.append(facts,el('p','rt-instruction','只核对这个 ID 的空会话；如果已有消息、已归档或身份不符，将停止。确认后只投递本项，不会另建。沿用这个会话当前的模型，不改变任何会话配置，也不会覆盖已有内容。'),confirm);
  node.append(el('h5','','恢复原空会话'),note,toggle,preview);
  let reviewed=null, submitted=null;
  const itemIn=state=>list(list(state?.tasks).find(t=>t.id===taskId)?.items).find(i=>i.id===itemId);
  const complete=i=>i?.recoverableEmpty===true && typeof i.expectedSessionId==='string' && i.expectedSessionId.trim() && typeof i.project==='string' && i.project.trim();
  const matches=(i,r)=>!!r && complete(i) && i.expectedSessionId===r.id && i.project===r.project && i.status===r.status;
  function togglePreview() {
    const item=itemIn(ctx.state);
    if (ctx.busy(feedback) || !ctx.online || !complete(item) || typeof ctx.api.recoverEmpty!=='function' || matches(item,submitted)) return;
    reviewed=reviewed ? null : {id:item.expectedSessionId,project:item.project,status:item.status};
    update(item);
  }
  function send() {
    const target=reviewed;
    if (!target || matches(itemIn(ctx.state),submitted) || !ctx.online || ctx.busy(feedback)) return;
    // Keep the reviewed address in any error, even if the host withdraws its offer in flight.
    const label='恢复空会话（原目录：'+target.project+'；会话 ID：'+target.id+'）';
    ctx.run(feedback,label,async()=>{
      // Recheck the current controller snapshot, even if a subscription notification was missed.
      // An in-progress read cannot authorize a replacement target or an already-unmounted view.
      const state=await ctx.api.getState();
      if (node.isConnected===false || !ctx.online || !state?.connected || reviewed!==target ||
          !matches(itemIn(ctx.state),target) || !matches(itemIn(state),target) || typeof ctx.api.recoverEmpty!=='function') {
        reviewed=null;
        throw Error('恢复预览已失效，未发送请求。请刷新并重新核对原目标目录和会话 ID。');
      }
      return ctx.api.recoverEmpty(taskId,itemId,target.id);
    },()=>{submitted=target;reviewed=null;return '已提交这一项的恢复请求，请查看本项进度。';});
  }
  function update(item) {
    if (reviewed && !matches(item,reviewed)) {
      reviewed=null;
      if (!ctx.busy(feedback)) msg(feedback,'恢复预览已失效：子项状态、原目录或预期会话 ID 已变更。请重新核对。','amber');
    }
    if (submitted && !matches(item,submitted)) submitted=null;
    node.hidden=item?.recoverableEmpty!==true;
    const supported=typeof ctx.api.recoverEmpty==='function', pending=ctx.busy(feedback);
    toggle.disabled=!complete(item) || !supported || !ctx.online || pending || !!submitted;
    text(note,!supported?'当前入口不支持恢复，请更新插件后刷新。':!complete(item)?'缺少原目标目录或精确会话 ID，不能恢复。请刷新状态。':submitted?'恢复请求已提交，等待状态更新。':'这不是普通重试。先核对上次为本项登记的目标，再决定是否恢复。');
    toggle.setAttribute('aria-expanded',String(!!reviewed)); text(toggle,reviewed?'收起恢复预览':'预览空会话恢复');
    preview.hidden=!reviewed; confirm.disabled=!reviewed || toggle.disabled;
    text(project,reviewed?.project); text(id,reviewed?.id);
  }
  return {node,update};
}
