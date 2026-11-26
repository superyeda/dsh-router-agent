import { list, order, text } from './shared.mjs';

// DOM ids are local handles for ARIA only. Project paths, session ids and other
// journal strings are opaque map keys / text, never selectors, ids or markup.
let serial=0;
const activeIn=node=>node.getRootNode?.().activeElement || node.ownerDocument.activeElement;
const contains=(node,other)=>!!other && (node===other || node.contains?.(other));
function attr(node,name,value) {if(node.getAttribute(name)!==value) node.setAttribute(name,value);}
function show(node,visible) {const hidden=!visible;if(node.hidden!==hidden) node.hidden=hidden;}

// insertBefore normally blurs an editor if it moves the editor's ancestor. If
// a new demand changes the order, move siblings around the focused branch.
function arrange(parent,nodes) {
  const old=[...parent.children];
  if(old.length===nodes.length && nodes.every((n,i)=>n===old[i])) return;
  const active=activeIn(parent), anchor=old.find(n=>contains(n,active)), k=nodes.indexOf(anchor);
  if(k<0) {order(parent,nodes);return;}
  const keep=new Set(nodes);
  for(const n of old) if(!keep.has(n)) n.remove();
  for(let i=0;i<k;i++) if(parent.children[i]!==nodes[i]) parent.insertBefore(nodes[i],parent.children[i] || null);
  for(let i=nodes.length-1;i>k;i--) {
    if(parent.children[parent.children.length-(nodes.length-i)]!==nodes[i]) parent.insertBefore(nodes[i],nodes[i+1] || null);
  }
}

// The group is an index into local history, not a capability. Find an actual
// bound occurrence in this exact directory; target rechecks the latest record,
// filter, connection and scope. Never use a candidate, roster title or bare sid.
function boundRef(ctx,project,session) {
  if(!session.sid || !project.path) return null;
  for(const saved of session.tasks) {
    const task=ctx.byTask ? ctx.byTask.get(saved.id) : saved;
    for(const item of list(task?.items)) {
      if(!item?.id || item.status==='clarify' || item.decision==='clarify' ||
        item.sessionId!==session.sid || item.project!==project.path) continue;
      const ref={kind:'bound',sid:session.sid,taskId:task.id,itemId:item.id};
      if(ctx.pane.target(ref)) return ref;
    }
  }
  return null;
}

/** Render a project > session > demand projection without owning demand views. */
export function createLedgerTree(ctx,container,leafFor) {
  const {el,button}=ctx.ui;
  // Disclosure choices belong to this mount, not to one filtered snapshot. Only
  // rendered branches hold DOM; leafFor owns its keyed, draft-bearing nodes.
  const open={project:new Set(),session:new Set()}, views={project:new Map(),session:new Map()};
  let groups=[], visibleTasks=new Set(), disposed=false;
  function interactive(row,trigger) {
    return !disposed && (!ctx.alive || ctx.alive()) && ctx.onBoard!==false && !container.hidden &&
      views[row.level].get(row.key)===row && trigger.isConnected!==false &&
      (!container.contains || container.contains(trigger)) && (!row.node.contains || row.node.contains(trigger)) && !trigger.closest?.('[hidden]');
  }
  function branch(level,key) {
    const isProject=level==='project', node=el('section','rt-ledger-branch rt-ledger-'+level);
    node.setAttribute('data-ledger-level',level);node.setAttribute('data-ledger-'+level,key);
    const bar=el('div','rt-ledger-row'), heading=el(isProject?'h3':'h4','rt-ledger-heading');
    const row={level,key,node}, toggle=row.toggle=button('',()=>{
      if(!interactive(row,toggle)) return;
      if(open[level].has(key)) {
        if(contains(row.panel,activeIn(container))) toggle.focus();
        open[level].delete(key);
      } else open[level].add(key);
      render();
    },'rt-ledger-toggle');
    const caret=el('span','rt-ledger-caret'); caret.setAttribute('aria-hidden','true');
    const copy=el('span','rt-ledger-copy'), title=el('span','rt-ledger-title');
    row.kind=el('span','rt-ledger-kind');row.label=el('span','rt-ledger-name');row.detail=el('span','rt-ledger-detail');
    title.append(row.kind,row.label);copy.append(title,row.detail);
    const meta=el('span','rt-ledger-meta');row.count=el('span','rt-ledger-count');
    row.attention=el('span','rt-ledger-state');row.attention.setAttribute('data-tone','amber');
    row.active=el('span','rt-ledger-state');row.active.setAttribute('data-tone','blue');
    meta.append(row.count,row.attention,row.active); toggle.append(caret,copy,meta); heading.append(toggle);bar.append(heading);
    row.bar=bar;row.panel=el('div','rt-ledger-children');row.panel.id='rt-ledger-panel-'+(++serial);
    toggle.setAttribute('data-ledger-toggle',level);toggle.setAttribute('aria-controls',row.panel.id);node.append(bar,row.panel);
    return row;
  }
  function paintRow(level,project,g) {
    const map=views[level], isProject=level==='project', expanded=open[level].has(g.key);
    let row=map.get(g.key);if(!row) {row=branch(level,g.key);map.set(g.key,row);}
    row.project=project;row.group=g;
    text(row.kind,isProject?(project.path?'项目':'需求分组'):(g.sid?'会话':'记录组'));
    text(row.label,g.label);text(row.detail,g.detail);show(row.detail,g.detail);
    const counts=isProject?[g.sessionCount+' 个会话',g.count+' 条需求']:[g.count+' 条需求'];
    // A legacy multi-target bucket isn't an unbound session, either. Use its
    // own label and number of demands instead of counting a fictitious session.
    if(isProject) for(const s of g.sessions) if(!s.sid && s.count) counts.push(s.label+' '+s.count+' 条');
    text(row.count,counts.join(' · '));
    text(row.attention,g.attention?'待处理 '+g.attention:'');show(row.attention,g.attention);
    text(row.active,g.active?'进行中 '+g.active:'');show(row.active,g.active);
    attr(row.toggle,'aria-expanded',String(expanded));show(row.panel,expanded);
    if(!isProject && g.sid) {
      if(!row.native) {
        const native=button('查看原会话',()=>{
          if(row.native!==native || native.disabled || !interactive(row,native)) return;
          const ref=boundRef(ctx,row.project,row.group);
          if(ref) ctx.pane.open(ref,native);
        },'rt-btn rt-ledger-open');row.native=native;
        row.native.setAttribute('data-ledger-open','session');
        if(ctx.pane.node?.id) row.native.setAttribute('aria-controls',ctx.pane.node.id);
        row.bar.append(row.native);
      }
      const allowed=!!boundRef(ctx,project,g);
      if(row.native.disabled!==!allowed) row.native.disabled=!allowed;
      attr(row.native,'title',allowed?'在任务台侧栏查看这个原会话':'当前不能核实原会话或目录许可；仍可展开本机需求。');
      attr(row.native,'aria-label','查看原会话：'+g.label+'（'+g.sid+'）');
      attr(row.node,'data-selected',String(allowed && !!ctx.pane.selectedSession?.(g.sid)));
    } else if(row.native) {
      row.native.remove();row.native=null;row.node.removeAttribute('data-selected');
    }
    return row;
  }
  function contents(row,nodes,emptyText) {
    if(!row.panel.hidden && !nodes.length) {
      row.empty??=el('p','rt-ledger-empty rt-muted',emptyText);nodes.push(row.empty);
    }
    arrange(row.panel,nodes);
  }
  function render() {
    const seen={project:new Set(),session:new Set()}, nextTasks=new Set(), projects=[];
    const focus=activeIn(container), hadFocus=contains(container,focus);
    const focused=level=>hadFocus && [...views[level].values()].find(v=>contains(v.node,focus));
    const fromSession=focused('session'), fromProject=focused('project');
    for(const p of ctx.onBoard===false?[]:groups) {
      if(ctx.filter && !p.count) continue;
      const pv=paintRow('project',p,p), sessions=[];seen.project.add(p.key);projects.push(pv.node);
      if(!pv.panel.hidden) for(const s of p.sessions) {
        if(ctx.filter && !s.count) continue;
        const sv=paintRow('session',p,s), leaves=[];seen.session.add(s.key);sessions.push(sv.node);
        if(!sv.panel.hidden) for(const t of s.tasks) {nextTasks.add(t.id);leaves.push(leafFor(t));}
        contents(sv,leaves,'此组还没有本机需求。');
      }
      contents(pv,sessions,'这个项目还没有本机需求。');
    }
    arrange(container,projects);
    for(const level of ['session','project']) for(const [key,row] of views[level]) if(!seen[level].has(key)) {
      // Do not leave a cached leaf holding its old enclosing DOM / snapshot.
      arrange(row.panel,[]);views[level].delete(key);
    }
    // Hiding a confirmation revokes that single-record preview, not the bulk
    // selection outside the tree. No journal or native-session action here.
    for(const id of visibleTasks) if(!nextTasks.has(id)) ctx.cleanup?.leave(id);
    visibleTasks=nextTasks;
    // If an authorized action disappears while focused, return to disclosure
    // instead of losing the keyboard location; never steal another control's focus.
    if(!disposed && ctx.onBoard!==false && hadFocus && (focus.isConnected===false || focus.disabled)) {
      const now=activeIn(container);
      if(!now || now===focus || now===container.ownerDocument.body) {
        (views.session.get(fromSession?.key) || views.project.get(fromProject?.key) || views.project.values().next().value)?.toggle.focus({preventScroll:true});
      }
    }
  }
  function update(next) {if(!disposed) {groups=list(next);render();}}
  // Only an explicit request reveals a path. Polls, newly arrived tasks and
  // title/authorization changes never change disclosure or open the side pane.
  function reveal(taskId) {
    if(disposed) return false;
    for(const p of groups) for(const s of p.sessions) if(s.tasks.some(t=>t.id===taskId)) {
      open.project.add(p.key);open.session.add(s.key);render();return true;
    }
    return false;
  }
  function dispose() {
    if(disposed) return;
    disposed=true;groups=[];render();open.project.clear();open.session.clear();
  }
  return {update,reveal,dispose};
}
