// One explicit occurrence in one already owner-verified panel. This code owns
// no transcript, token, prompt, pending answer or native Agent. The renderer
// receives an exact rc.5 SessionReference, never the main view's selection.
const denied = '此会话已不在当前授权范围、连接已断开，或无法核实其目录。会话内容已清除；请刷新后重新选择。';
const unavailable = '未能打开 DSH 原生会话。请核实当前连接、目录授权及原生会话组件后重试。';
const actions = ['session/projections', 'session/follow', 'session/page', 'session/prompt'];
const flex = 'display:flex;flex:1 1 0%;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden';
const noop = () => {};

/** mount(container, id) returns an immediate, idempotent disposer, including during proof/open. */
export function createSessionPanes({ctx, api, adapter, ownerGeneration, verifyOwner, present}) {
  let current, disposed = false;
  function mount(container, id) {
    if (disposed) return noop;
    current?.();
    const doc = container.ownerDocument, section = doc.createElement('div'), status = doc.createElement('p');
    section.setAttribute('style', flex); status.setAttribute('role','status');
    status.textContent = '正在核实原会话、目录与操作权限…';
    section.append(status); container.append(section);
    const cancel = new AbortController(), releases = [];
    const signal = cancel.signal;
    let stopped = false, outlet, directory, session, openingComplete = false, timer;
    function own(release) {
      if (typeof release !== 'function') throw Error('Missing native disposer');
      if (stopped) release(); else releases.push(release);
    }
    function end(reason) {
      if (stopped) return;
      stopped = true; clearTimeout(timer);
      // Detach the portal target synchronously, even if React is itself in the
      // middle of unmounting. Do not mutate its React-owned descendants.
      if (outlet) {outlet.inert = true; outlet.remove();}
      cancel.abort();
      // Withdraw the native controls (including overlays) before releasing
      // the exact reference. A faulty disposer must not strand another lease.
      while (releases.length) {try {releases.pop()();} catch { /* continue teardown */ }}
      if (reason) {status.textContent = reason; status.hidden = false;}
    }
    function close() {
      end(); section.remove();
      if (current === close) current = undefined;
    }
    current = close;
    const fail = () => end(denied);
    let cwd;
    function permitted() {
      if (stopped || !cwd || api.sessionPaneTarget(id) !== cwd || !ownerGeneration
        || ctx.connection.generation.getSnapshot() !== ownerGeneration) return false;
      const list = ctx.sessions.list.getSnapshot(), row = list.byId[id], ws = ctx.workspaces.list.getSnapshot();
      // byId includes retained/fallback rows; only ids proves roster membership.
      if (list.phase !== 'ready' || !list.ids.includes(id) || row?.id !== id || row.cwd !== cwd
        || row.origin !== undefined || row.formatStatus !== 'current' || ws.phase !== 'ready'
        || ws.state === 'error' || !Array.isArray(ws.archivedSessionIds) || ws.archivedSessionIds.includes(id)) return false;
      const latest = list.projectionsBySession[id];
      if (latest && (latest.state === 'migration-required' || latest.state === 'error'
        || (Object.hasOwn(latest.values, 'workingDirectory') && latest.values.workingDirectory !== cwd))) return false;
      if (!session) return true;
      const snap = session.getSnapshot(), actual = directory.getSnapshot();
      return snap.sessionId === id && snap.removed === false && snap.subagent === null && snap.openState !== 'error'
        && (openingComplete ? snap.openState === 'open' && actual === cwd : actual === undefined || actual === cwd);
    }
    function check() {
      try {if (permitted()) return true;} catch { /* malformed or disposed source */ }
      fail(); return false;
    }
    async function open() {
      cwd = api.sessionPaneTarget(id);
      if (!check()) return;
      if (typeof present !== 'function') {end(unavailable); return;}
      own(api.subscribe(check));
      for (const source of [ctx.connection.generation, ctx.sessions.list, ctx.workspaces.list]) own(source.subscribe(check));
      // Native resource owners, not invented access flags. whenAccess installs
      // synchronously for an allowed action. A withdrawn grant ends this
      // selection; re-grant/reconnect must not re-open it behind the user's back.
      for (const action of actions) {
        if (stopped) return;
        let allowed = false;
        own(ctx.uiSession.whenAccess(id, action, () => {allowed = true; return fail;}));
        if (!allowed) {fail(); return;}
      }
      await acquire(false);
    }
    async function acquire(confirmedCold) {
      if (!check()) return;
      await verifyOwner(signal);
      if (!check()) return;
      const proof = await adapter.inspectPaneTarget(id, cwd, signal);
      if (!check()) return;
      if (!confirmedCold && proof.active === false) {
        // rc.5 retain() opens an activating stream even for historical rows.
        // Inspecting a candidate alone is not consent to wake its native Agent.
        clearTimeout(timer);
        status.textContent = '此会话尚未载入。载入会唤醒这个原会话，不会提交新任务；也可以直接关闭。';
        const button = doc.createElement('button'); button.type = 'button'; button.textContent = '载入原会话';
        const choose = () => {
          if (button.disabled || !check()) return;
          button.disabled = true; button.remove();
          status.textContent = '正在重新核实授权并载入原会话…';
          timer = setTimeout(() => end(unavailable), 15000);
          void acquire(true).catch(() => end(unavailable));
        };
        button.addEventListener('click', choose); section.append(button);
        own(() => {button.removeEventListener('click', choose); button.remove();});
        return;
      }
      if (typeof proof.active !== 'boolean') {fail(); return;}
      const ref = ctx.sessions.retain(id, {source:'routerPane', signal});
      own(() => ref.release());
      if (stopped) return;
      if (ref.sessionId !== id || ref.binding.sessionId !== id) {fail(); return;}
      session = ref.binding.session; directory = session.projections.faceOf('workingDirectory');
      own(directory.subscribe(check)); own(session.subscribe(check));
      if (!check()) return;
      const ready = await ref.ready;
      openingComplete = true;
      if (!check()) return;
      if (ready !== ref.binding || ready.session !== session) {fail(); return;}
      outlet = doc.createElement('div'); outlet.setAttribute('style', flex);
      outlet.setAttribute('data-router-native-session',id);
      section.append(outlet); status.hidden = true;
      own(present(outlet, ref));
      clearTimeout(timer);
    }
    timer = setTimeout(() => end(unavailable), 15000);
    void open().catch(() => end(unavailable));
    return close;
  }
  return {mount, dispose() {disposed = true; current?.();}};
}
