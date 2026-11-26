import { createDshAdapter } from './dsh/adapter.mjs';

// These are Cordis services, not properties on a plain RPC client. The panel
// consumes them from its injected child fiber, after the parent owns $mount.
export const panelServices = ['remote', 'remote.session', 'remote.workspace',
  'remote.remoteAccess', 'remote.routerAgent', 'remoteAccess', 'slots',
  'sessions', 'workspaces', 'uiSession', 'connection'];

export function bindPanelTransport(ctx) {
  const wire = ctx.remote;
  const remote = { session: wire.session, workspace: wire.workspace,
    remoteAccess: wire.remoteAccess, routerAgent: wire.routerAgent };
  return {
    remote,
    // The adapter has a mutable allowlist; never share it across panel opens.
    newAdapter: () => createDshAdapter(remote),
    async infer({system,user,provider,model,effort,signal}) {
      const r = await remote.routerAgent.infer({system,user,provider,model,...(effort ? {effort} : {})},signal);
      if (!r.ok) throw Error(r.error?.message || '意图模型调用失败');
      return r.value.text;
    },
  };
}
