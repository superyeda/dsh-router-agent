import React from 'react';
import { createPortal, flushSync } from 'react-dom';
import { routerAgentRemoteContribution } from './host/contract.mjs';
import { bindPanelTransport, panelServices } from './client-transport.mjs';
import { createRouter } from './core/controller.mjs';
import { browserJournal } from './core/journal.mjs';
import { mountRouter } from './ui/main.mjs';
import { createSessionPanes } from './ui/session-pane.mjs';

// The provider cannot depend on remote.routerAgent at this level: its own
// apply() must run first to publish that namespace. Only its child consumes it.
export const inject=['remote'];
const panelId='personal-session-router', paneSlot='routerAgent.sessionPane';
async function verifyOwner(remote, cancel) {
  const timeout=AbortSignal.timeout(10000), operation=new AbortController();
  const signal=AbortSignal.any([cancel,timeout,operation.signal]);
  try {
    for await(const frame of remote.remoteAccess.follow(signal)) {
      signal.throwIfAborted();
      if(frame?.type==='baseline' && frame.owner===true) return;
      throw Error('这是个人入口，仅对当前 DSH 的拥有者开放。');
    }
    throw Error('未收到 DSH 的授权信息。请检查连接后重试。');
  } finally {operation.abort();}
}
// The local views position receives the Factory's (not the panel's) child
// rights. This mirrors rc.5 ui-subagent/sidebar-chat's fixed Chat occurrence.
function FixedChat({renderSlot}) {return renderSlot('conversation.session',{view:'chat'});}
const views={views:FixedChat};
function NativeConversation({sessionId,expectedSessionId,renderFactorySlot}) {
  const error=React.createElement('p',{role:'status'},'DSH 原生会话组件不可用，未启用输入或审批。');
  if(!sessionId || sessionId!==expectedSessionId) return error;
  // The selected occurrence is always an existing Session: no new-Session hero,
  // global workspace navigation or main-view width controls inside the board.
  return renderFactorySlot('conversation.content',{variant:'embedded',phase:'active',hero:false},{slots:views,fallback:error});
}
function RouterPage({connectRouter,SessionProvider,renderSlot}) {
  const root=React.useRef(null), sequence=React.useRef(0), [pane,setPane]=React.useState(null);
  React.useLayoutEffect(()=>{
    let live=true;
    const stop=connectRouter(root.current,(container,reference)=>{
      if(!live) throw Error('入口已关闭。');
      const entry={container,reference,live:true,owner:connectRouter,key:String(++sequence.current)};
      setPane(entry);
      return ()=>{
        entry.live=false;
        // A native menu/approval can itself portal into document.body. Withdraw
        // the React subtree as well as its detached DOM before releasing the ref.
        if(live) flushSync(()=>setPane(value=>value===entry?null:value));
      };
    });
    return ()=>{live=false;stop();};
  },[connectRouter]);
  const portal=pane?.live && pane.owner===connectRouter ? createPortal(
    React.createElement(SessionProvider,{session:pane.reference},renderSlot(paneSlot,{expectedSessionId:pane.reference.sessionId})),pane.container,pane.key) : null;
  // A second root, including uiRenderer.mount(), would lose the Slot host and
  // Session scopes. A portal keeps the original React tree and its providers.
  return React.createElement(React.Fragment,null,React.createElement('div',{ref:root,style:{height:'100%',minHeight:0,overflow:'auto',boxSizing:'border-box',paddingTop:'var(--dsh-frame-top-clearance, 0px)'}}),portal);
}
function Icon({size=20}) {
  const h=React.createElement;
  return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,'aria-hidden':true},h('path',{d:'M7 12h4a4 4 0 004-4V6m-4 6a4 4 0 014 4v2'}),h('circle',{cx:5,cy:12,r:2}),h('circle',{cx:16,cy:4,r:2}),h('circle',{cx:16,cy:20,r:2}));
}
function mountPage(ctx,transport,root,draftScope,present) {
  let generation=0, cleanup=()=>{}, closed=false;
  async function connect() {
    cleanup(); const mine=++generation, cancel=new AbortController(); let api,panes,unmount,timer;
    const stillHere=()=>!closed && generation===mine && !cancel.signal.aborted;
    cleanup=()=>{cancel.abort();clearTimeout(timer);panes?.dispose();unmount?.();api?.dispose();};
    root.replaceChildren();const msg=root.ownerDocument.createElement('p');msg.textContent='正在验证 DSH 连接…';root.append(msg);
    try {
      const ownerGeneration=ctx.connection.generation.getSnapshot();
      await verifyOwner(transport.remote,cancel.signal);if(!stillHere()) return;
      const adapter=transport.newAdapter();
      api=createRouter({adapter,journal:browserJournal(),
        infer:({signal,...input})=>transport.infer({...input,signal:signal ? AbortSignal.any([cancel.signal,signal]) : cancel.signal})});
      panes=createSessionPanes({ctx,api,adapter,ownerGeneration,present,verifyOwner:signal=>verifyOwner(transport.remote,signal)});
      api.mountSessionPane=panes.mount;
      api.draftScope=draftScope;
      root.replaceChildren();unmount=mountRouter(root,api);
      // No headless scheduler, server, access token or cross-origin connection.
      // DSH keeps executing already-accepted prompts even after closing the panel.
      await api.refresh().catch(()=>{});
      const poll=async()=>{if(!stillHere())return;try{await api.tick();}catch{/* surfaced by controller */}if(stillHere()) timer=setTimeout(poll,3000);};
      if(stillHere()) timer=setTimeout(poll,2000);
    } catch(e) {
      if(!stillHere())return;msg.textContent=e?.message || '连接失败。请刷新 DSH 后重试。';
      const btn=root.ownerDocument.createElement('button');btn.type='button';btn.textContent='重新连接';btn.onclick=()=>{void connect();};root.replaceChildren(msg,btn);
    }
  }
  void connect();const reset=ctx.on('connection/reset',()=>{void connect();});
  return ()=>{if(closed)return;closed=true;cleanup();reset();root.replaceChildren();};
}
export async function apply(ctx) {
  const unmount=await ctx.remote.$mount(routerAgentRemoteContribution);
  try {
    const panel=ctx.inject(panelServices, child=>{
      const transport=bindPanelTransport(child);
      return child.remoteAccess.whenAccess('routerAgent/infer',function*(){
        const draftScope={}, pages=new Set();
        const connectRouter=(root,present)=>{
          const disconnect=mountPage(child,transport,root,draftScope,present);
          const close=()=>{pages.delete(close);disconnect();}; pages.add(close);return close;
        };
        yield child.slots.inject('main',()=>child.slots.register({name:'main',key:panelId,children:{[paneSlot]:{kind:'single',scope:'session'}},inject:()=>({connectRouter})},RouterPage));
        yield child.slots.inject(paneSlot,()=>child.slots.register({name:paneSlot},NativeConversation));
        yield child.slots.inject('sidebar.panellist',()=>child.slots.register({name:'sidebar.panellist',id:panelId,order:12,label:()=>'任务路由'},Icon));
        yield ()=>{for(const close of pages) close();};
      });
    });
    return async()=>{try {await panel.dispose();} finally {await unmount();}};
  } catch(e) {await unmount();throw e;}
}
