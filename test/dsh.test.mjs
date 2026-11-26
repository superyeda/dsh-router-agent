import test from 'node:test';
import assert from 'node:assert/strict';
import {createDshAdapter} from '../src/dsh/adapter.mjs';
import {expectedRecoveryId} from '../src/host/contract.mjs';

const ok = value => ({ok: true, value});
const fail = (message, code = 'test/unavailable') => ({ok: false, error: {code, message}});
const A = '/fake/project', B = '/fake/other';
const row = (id, cwd = A, extra = {}) => ({sessionId: id, cwd, agentAvailable: true, formatStatus: 'current',
  blank: false, running: false, updatedAt: 42, projections: {kind:'sequenced', asOfSeq:5,
    values:{workingDirectory:cwd,title:'标题-' + id}}, ...extra});
const txt = text => ({type:'text', text});
const user = (rpcId, text = '任务') => ({role:'user', id:'msg-' + rpcId, source:{kind:'user', rpcId}, content:[txt(text)]});
const ev = (type, data, surfaceOp) => ({type, data, ...(surfaceOp === undefined ? {} : {surfaceOp})});
const start = turn => ev('turn/start', {turn});
const step = (turn, n = 1) => ev('step/start', {turn,step:n});
const stepEnd = (turn, n = 1) => ev('step/end', {turn,step:n});
const prompt = (id, text) => ev('user/message', user(id,text), 'append');
const assistant = (turn, content, n = 1, extras = {}) => ev('assistant/message', {turn, step:n,
  message:{role:'assistant', content: typeof content === 'string' ? [txt(content)] : content}, stream:[], ...extras}, 'append');
const end = (turn, kind = 'completed', fields = {}) => ev('turn/end', {turn,reason:{kind,...fields}});
const turn = (n, id, reply) => [start(n), step(n), prompt(id), assistant(n, reply), stepEnd(n), end(n)];
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
}

// Shape-faithful fake of the generated RC5 client: business arguments are
// positional, unary results are enveloped, and workspace.follow yields raw
// frames. No calls to the host, local persistence, browser or network.
function fixture() {
  const f = {
    workspaces: [{workspaceId:'wa', path:A, title:'项目 A', sessionIds:[]}, {workspaceId:'wb', path:B, title:'其他', sessionIds:[]}],
    rows: [row('a'),row('b',B)], archives: [], live:{}, log:[], seen:new Set(), creations:new Map(),
    follows: 0, closed: 0, pages:[], prompts:[], configs:[], creates:[], lists:0, states:[], nativeWrites:0,
    exact:new Map(), projectionReads:[], recoveries:[],
    modelCatalog:{groups:[{id:'p',models:[{id:'main',reasoning:{efforts:[{id:'low'},{id:'high'}]}},{id:'fast'}]},
      {id:'off',models:[{id:'hidden'}]}],routableProviders:['p'],failures:[]},
    frame: null,
  };
  const nativeWrite = () => { f.nativeWrites++; throw Error('unexpected non-session-local write'); };
  const remote = {
    workspace: {async *follow(signal) {
      assert.ok(signal instanceof AbortSignal); f.follows++;
      try { yield f.frame ?? {type:'baseline',value:{items:f.workspaces,archivedSessionIds:[...f.archives],pinnedSessionIds:[]}}; }
      finally { f.closed++; }
    }},
    session: {
      async list(req, signal) { assert.deepEqual(req,{}); assert.ok(signal instanceof AbortSignal); f.lists++; return ok({items:f.rows}); },
      async modelCatalog() { assert.equal(arguments.length,0); return ok(f.modelCatalog); },
      async projections({sessionId},signal) {
        assert.ok(signal instanceof AbortSignal); f.projectionReads.push(sessionId);
        if (f.exact.has(sessionId)) return ok(f.exact.get(sessionId));
        const row=f.rows.find(r=>r.sessionId===sessionId);
        return ok(row?.projections ? {kind:'sequenced',asOfSeq:f.log.length-1,
          values:{...row.projections.values}} : null);
      },
      async state({sessionId},signal) { assert.ok(signal instanceof AbortSignal); f.states.push(sessionId);
        return ok({cursor:f.log.length-1,active:true,running:false,queue:[],pendingInput:[],...f.live}); },
      async events(req, signal) {
        assert.ok(signal instanceof AbortSignal); assert.equal(req.address.kind,'session'); f.pages.push({...req});
        const cursor = req.throughSeq ?? f.log.length - 1;
        const stop = Math.min(req.beforeSeq ?? cursor+1,cursor+1);
        let first = stop, count = 0;
        while (first > 0) {
          const e=f.log[--first];
          if (e.surfaceOp === 'append' && ['user/message','assistant/message'].includes(e.type) && ++count >= req.maxMessages) break;
        }
        return ok({cursor,hasMore:first>0,records:f.log.slice(first,stop).map((event,i)=>({type:'event',event:{...event,seq:first+i,time:42}}))});
      },
      async prompt(req,signal) { assert.ok(signal instanceof AbortSignal); f.prompts.push(req); f.seen.add(req.requestId); return ok({accepted:true}); },
      selectModel:nativeWrite, create:nativeWrite, cancel:nativeWrite, updateQueue:nativeWrite,
    },
    routerAgent: {
      async create(req) {
        f.creates.push(req);
        const prev = f.creations.get(req.requestId);
        if (prev && prev.cwd !== req.cwd) return fail('创建标识已用于不同目录');
        if (!prev) {
          const sessionId = 'owned-' + (f.creations.size+1);
          f.creations.set(req.requestId,{sessionId,cwd:req.cwd});
          f.rows.push(row(sessionId,req.cwd,{blank:true}));
        }
        return ok({sessionId:f.creations.get(req.requestId).sessionId});
      },
      async recoverEmpty(req,signal) {
        assert.ok(signal instanceof AbortSignal); f.recoveries.push(req);
        return ok({sessionId:req.sessionId,cursor:f.log.length-1});
      },
      async configure(req) { f.configs.push(req); return ok({ok:true}); },
    },
  };
  return { f, remote, adapter:createDshAdapter(remote) };
}

const key = 'ra-16a69f62-3b65-4a43-b67c-dd8bd8ab50ea', recoveryId = expectedRecoveryId(key);
function emptyFixture() {
  const env = fixture();
  // The actual event classification is the host's responsibility; the adapter
  // sees a stable, non-negative last seq, not a magic count of setup events.
  env.f.log = Array.from({length:4},()=>ev('test/initialization',{}));
  env.f.rows = [row(recoveryId,A,{blank:true,agentAvailable:false})];
  return env;
}
const setupRecovery = async () => {const env = emptyFixture(); await env.adapter.listSessions([A]); return env;};

// Discovery and authority.
test('workspace baseline yields real paths; list returns only confirmed nonblank, exact-directory, ordinary resumable sessions', async () => {
  const {adapter,f} = fixture();
  f.rows = [row('ok',A,{running:true}), row('wrong',B), row('nested', A + '/child'), row('prefix', A+'2'),
    row('archived'), row('child',A,{origin:'subagent',parentSessionId:'ok'}), row('future',A,{origin:'new-kind'}),
    row('blank',A,{blank:true}), row('migrate',A,{formatStatus:'migration-required'}), row('unknown-format',A,{formatStatus:undefined}),
    row('cold-miss',A,{agentAvailable:false,projections:undefined}),
    row('cold',A,{agentAvailable:false,projections:{kind:'cached',asOfSeq:3,values:{workingDirectory:A,sessionListMetadata:{blank:false},title:'冷会话'}}}),
    row('ordinary-fork',A,{parentSessionId:'old'}),
    row('has-queue',A,{projections:{kind:'sequenced',asOfSeq:6,values:{workingDirectory:A,inbox:{'next-turn':[user('queued')]}}}})];
  f.archives = ['archived'];
  assert.deepEqual(await adapter.listWorkspaces(),[{name:'项目 A',path:A},{name:'其他',path:B}]);
  const sessions = await adapter.listSessions(new Set([A]));
  assert.deepEqual(sessions.map(x=>x.id),['ok','cold','ordinary-fork','has-queue']);
  assert.deepEqual(sessions[0],{id:'ok',cwd:A,title:'标题-ok',updatedAt:42,busy:true});
  assert.equal(sessions[1].title,'冷会话'); assert.equal(sessions[3].busy,true);
  await assert.rejects(adapter.recent('nested'),/授权/);
  assert.equal(f.pages.length,0); assert.equal(f.follows,f.closed);
  assert.deepEqual(await adapter.listSessions([]),[]); assert.equal(f.lists,1);
  await assert.rejects(adapter.cursor('ok'),/授权/);
});

test('opening native chat needs the exact visible row and fresh archive / directory / active proof; no history or mutation', async () => {
  const {adapter,remote,f}=fixture(), signal=new AbortController().signal;
  await adapter.listSessions([A]);
  for(const [id,cwd] of [['foreign',A],['a',B],['b',A]]) await assert.rejects(adapter.inspectPaneTarget(id,cwd,signal));
  assert.deepEqual(f.states,[]);
  assert.deepEqual(await adapter.inspectPaneTarget('a',A,signal),{active:true});
  f.live={active:false};assert.deepEqual(await adapter.inspectPaneTarget('a',A,signal),{active:false});
  const state=remote.session.state;remote.session.state=async(...args)=>{const value=await state(...args); f.archives=['a'];return value;};
  await assert.rejects(adapter.inspectPaneTarget('a',A,signal),/归档/);
  f.archives=[];await adapter.listSessions([A]);
  f.exact.set('a',{kind:'cached',values:{workingDirectory:A}});
  await assert.rejects(adapter.inspectPaneTarget('a',A,signal),/实际工作目录/);
  assert.equal(f.pages.length+f.creates.length+f.configs.length+f.prompts.length+f.nativeWrites,0);
  const recovery=await setupRecovery();
  await recovery.adapter.bindRecoveryObservation(A,key,recoveryId);
  await assert.rejects(recovery.adapter.inspectPaneTarget(recoveryId,A,signal),/授权/);
});

test('pane close aborts its own preflight and never requests the next private source',async()=>{
  const {adapter,remote,f}=fixture(), cancel=new AbortController(), entered=deferred(), release=deferred();
  await adapter.listSessions([A]);
  remote.session.projections=async(_request,signal)=>{entered.resolve(signal);await release.promise;return ok({kind:'sequenced',asOfSeq:88,values:{workingDirectory:A}});};
  const inspecting=adapter.inspectPaneTarget('a',A,cancel.signal);
  const wireSignal=await entered.promise; cancel.abort(); assert.equal(wireSignal.aborted,true);
  release.resolve(); await assert.rejects(inspecting); assert.deepEqual(f.states,[]);assert.deepEqual(f.pages,[]);
});

test('recent returns only three bounded human prompt texts, never tool/context/assistant/attachments', async () => {
  const {adapter,f} = fixture(); await adapter.listSessions([A]);
  f.log = [prompt('one','过早'),prompt('two','第二'),prompt('three','第三'),
    ev('user/message',{...user('runtime','内部系统信息'),source:{kind:'runtime-context'}},'append'),
    ev('tool/result',{message:{content:[txt('工具输出')]}},'append'),assistant(1,'回答'),
    ev('user/message',{...user('last'),content:[{type:'image',data:'private'},txt('甲'.repeat(400))]},'append'),
    ev('user/message',user('replaced','不是新任务'),{op:'replace',startSeq:3,endSeq:3})];
  assert.deepEqual(await adapter.recent('a'),['第二','第三','甲'.repeat(320)+'…']);
  assert.deepEqual(f.pages.map(q=>[q.address.sessionId,q.maxMessages,q.throughSeq]),[['a',8,f.log.length-1]]);
  await adapter.listSessions([B]); await assert.rejects(adapter.recent('a'),/授权/);
  assert.equal(f.pages.length,1);
});

test('revocation during history read and superseded list do not disclose or restore old permissions', async () => {
  const {adapter,f,remote} = fixture(); await adapter.listSessions([A]); f.log = [prompt('x')];
  const entered = deferred(), release = deferred();
  remote.session.events = async () => { entered.resolve(); await release.promise;
    return ok({cursor:0,records:[{type:'event',event:{...prompt('x','不得返回'),seq:0}}],hasMore:false}); };
  const read = adapter.recent('a'); await entered.promise; await adapter.listSessions([B]); release.resolve();
  await assert.rejects(read,/授权/);
  const listed = deferred(), resolve = deferred(); let calls=0;
  remote.session.list = async () => { if (calls++ === 0) { listed.resolve(); await resolve.promise; } return ok({items:f.rows}); };
  const old = adapter.listSessions([A]); await listed.promise; await adapter.listSessions([B]); resolve.resolve();
  await assert.rejects(old); await assert.rejects(adapter.recent('a'),/授权/);
  await assert.rejects(adapter.listSessions(['../bad']),/绝对/); await assert.rejects(adapter.recent('b'),/授权/);
});

test('archive is checked live before history/send and again before returning delayed sensitive text; missing baseline fails closed', async () => {
  const {adapter,f,remote} = fixture(); await adapter.listSessions([A]);
  f.archives = ['a']; await assert.rejects(adapter.deliver('a','key','x'),/归档/);
  assert.equal(f.prompts.length,0);
  f.archives=[]; await adapter.listSessions([A]);
  const events = remote.session.events; remote.session.events = async (...args)=>{const v=await events(...args); f.archives=['a']; return v;};
  f.log=[prompt('last','保密')]; await assert.rejects(adapter.recent('a'),/归档/);
  f.archives=[]; await adapter.listSessions([A]); f.frame={type:'archived',archivedSessionIds:[]};
  await assert.rejects(adapter.recent('a'),/归档基线/);
  assert.equal((await adapter.observe('a','id',-1)).status,'unknown');
  await assert.rejects(adapter.listSessions([A]),/归档基线/);
  assert.equal(f.closed,f.follows);
});

test('header and effective directories must agree even if BOTH are allowed. Cold hints do not prove the current workingDirectory.', async () => {
  const {adapter,f} = fixture();
  const projection = (kind,cwd) => ({kind,asOfSeq:9,values:{workingDirectory:cwd,sessionListMetadata:{blank:false}}});
  f.rows=[row('good'),row('drift',A,{projections:projection('sequenced',B)}),
    row('cold-drift',A,{agentAvailable:false,projections:projection('cached',A)}),
    row('missing',A,{projections:undefined}),row('null-dir',A,{projections:projection('sequenced',null)}),
    row('upgraded',A,{projections:undefined}),row('migration',A,{projections:undefined}),row('out','/not-authorized',{projections:undefined})];
  f.exact.set('cold-drift',projection('sequenced',B));
  f.exact.set('upgraded',projection('sequenced',A)); f.exact.set('migration',{kind:'migration-required',values:{workingDirectory:A}});
  assert.deepEqual((await adapter.listSessions([A,B])).map(x=>x.id),['good','upgraded']);
  assert.ok(!f.projectionReads.includes('out')); await assert.rejects(adapter.recent('drift'),/授权/);
});

test('a live directory change between selection, read, dispatch, or owned-session recovery is fail-closed', async () => {
  const {adapter,remote,f} = fixture(); await adapter.listSessions([A,B]);
  const drift={kind:'sequenced',asOfSeq:10,values:{workingDirectory:B}};
  f.exact.set('a',drift);await assert.rejects(adapter.deliver('a','mine','do not send'),/实际工作目录/);
  assert.equal(f.prompts.length,0);await assert.rejects(adapter.recent('a'),/授权/);assert.equal(f.pages.length,0);
  f.exact.delete('a');await adapter.listSessions([A,B]);const events=remote.session.events;
  remote.session.events=async(...args)=>{const v=await events(...args);f.exact.set('a',drift);return v;};
  f.log=[prompt('mine','do not surface')]; await assert.rejects(adapter.recent('a'),/实际工作目录/);
  const id=await adapter.createSession(A,'ra-owned');f.exact.set(id,{kind:'sequenced',asOfSeq:9,values:{}});
  await assert.rejects(adapter.configure(id,{provider:'p',model:'fast'}),/实际工作目录/);assert.equal(f.configs.length,0);
  await assert.rejects(adapter.createSession(A,'ra-owned'),/实际工作目录/);
  await assert.rejects(adapter.deliver(id,'no-bypass','no'),/授权/);
});

test('working directory changed away and back: return only current-epoch snippets and no cross-project dependency output', async () => {
  const {adapter,f}=fixture();await adapter.listSessions([A]);
  f.log=[start(1),step(1),prompt('mine','从原项目发起'),ev('working-directory/change',{cwd:B}),
    prompt('else','另一个目录的秘密'),ev('working-directory/change',{cwd:A}),prompt('new','切回后的任务'),assistant(1,'跨目录结果'),end(1)];
  assert.deepEqual(await adapter.recent('a'),['切回后的任务']);
  const outcome=await adapter.observe('a','mine',-1);assert.equal(outcome.status,'unknown');assert.equal(outcome.result,undefined);assert.match(outcome.error,/工作目录/);
});

// Writes are narrow, idempotent gateway operations; never modify other agents.
test('create receipt survives a lost response; blank is not a reuse candidate, stable key is not a session id', async () => {
  const {adapter,f,remote} = fixture(); await adapter.listSessions([A,B]);
  const create = remote.routerAgent.create; let lose = true;
  remote.routerAgent.create = async req => { const v=await create(req); if (lose) {lose=false;return fail('回执丢失');}return v; };
  await assert.rejects(adapter.createSession(A,'ra-stable'),/回执丢失/);
  const id=await adapter.createSession(A,'ra-stable'); assert.notEqual(id,'ra-stable');
  assert.equal(await adapter.createSession(A,'ra-stable'),id); assert.equal(f.creations.size,1);
  assert.deepEqual(f.creates[0],{cwd:A,requestId:'ra-stable'});
  await assert.rejects(adapter.createSession(B,'ra-stable'),/不同目录/);
  await assert.rejects(adapter.createSession('/ungranted','key'),/授权/);
  const rows=await adapter.listSessions([A]); assert.ok(!rows.some(x=>x.id===id));
  await assert.rejects(adapter.recent(id),/授权/); assert.equal(await adapter.cursor(id),-1);
  const reopened=createDshAdapter(remote); await reopened.listSessions([A]); await assert.rejects(reopened.cursor(id),/授权/);
  assert.equal(await reopened.createSession(A,'ra-stable'),id); assert.equal(await reopened.cursor(id),-1);
  assert.equal(f.nativeWrites,0);
});

test('catalog flattens available routes; only a router-owned blank can be explicitly configured, no native/global fallback', async () => {
  const {adapter,f,remote} = fixture(); await adapter.listSessions([A]);
  assert.deepEqual(await adapter.catalog(),[{provider:'p',model:'main',efforts:['low','high']},{provider:'p',model:'fast',efforts:[]}]);
  const config = {provider:'p',model:'main',effort:'high'};
  await assert.rejects(adapter.configure('a',config),/只允许/);
  const id=await adapter.createSession(A,'model-key');
  await assert.rejects(adapter.configure(id,{...config,effort:'unsupported'}),/当前可选/);
  await adapter.configure(id,config); await adapter.configure(id,{provider:'p',model:'fast',effort:''});
  assert.deepEqual(f.configs,[{sessionId:id,...config},{sessionId:id,provider:'p',model:'fast'}]);
  remote.routerAgent.configure = async () => fail('该会话已启动','router/busy');
  await assert.rejects(adapter.configure(id,config),e=>e.code==='router/busy');
  delete remote.routerAgent; await assert.rejects(adapter.configure(id,config),/不会回退/);
  assert.equal(f.nativeWrites,0);
});

test('deliver always queues with the durable rpc key; decline unsupported replies, empty continuations, revoked scopes', async () => {
  const {adapter,f,remote} = fixture(); await adapter.listSessions([A]);
  await adapter.deliver('a','ra-try','  请求  '); await adapter.deliver('a','ra-try','  请求  ');
  assert.deepEqual(f.prompts,Array.from({length:2},()=>({sessionId:'a',requestId:'ra-try',mode:'queue',content:[txt('  请求  ')]})));
  assert.equal(f.seen.size,1); await assert.rejects(adapter.deliver('a','ra-empty','  '),/非空/);
  await assert.rejects(adapter.deliver('b','deny','请求'),/授权/);
  remote.session.prompt=async()=>ok({});await assert.rejects(adapter.deliver('a','ra-new','x'),/未确认入队/);
  assert.equal(f.nativeWrites,0);
});

// Recovery is a layered capability, not a new way to claim old sessions.
test('only explicit owner recovery grants one enqueue at the verified cut, never configure or recent', async () => {
  const {adapter,f}=await setupRecovery();
  await assert.rejects(adapter.cursor(recoveryId),/授权/);
  assert.equal(await adapter.recoverEmpty(A,key,recoveryId),recoveryId);
  assert.deepEqual(f.recoveries,[{requestId:key,sessionId:recoveryId,cwd:A}]);
  assert.deepEqual(await adapter.listSessions([A]),[]); // recovery does not promote blank to candidate
  await assert.rejects(adapter.recent(recoveryId),/授权/);
  await assert.rejects(adapter.configure(recoveryId,{provider:'p',model:'main'}),/只允许/);
  assert.equal(await adapter.cursor(recoveryId),3);
  const sends=await Promise.allSettled([adapter.deliver(recoveryId,'rpc','one'),adapter.deliver(recoveryId,'rpc','one')]);
  assert.equal(sends.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.prompts.length,1);
  assert.deepEqual(f.prompts[0],{sessionId:recoveryId,requestId:'rpc',mode:'queue',content:[txt('one')]});
  await assert.rejects(adapter.deliver(recoveryId,'new-rpc','again'),/授权/);
  await assert.rejects(adapter.cursor(recoveryId),/授权/);
  f.live={queue:[{placement:'queued',rpcId:'rpc'}]};assert.deepEqual(await adapter.observe(recoveryId,'rpc',3),{status:'queued'});
  assert.equal(f.nativeWrites,0);assert.equal(f.configs.length,0);assert.equal(f.creates.length,0);
});

test('observation binding uses a real scoped ordinary header, not an owner RPC; gives no send or cursor even after ambiguous ack', async () => {
  const {adapter,remote,f}=await setupRecovery();
  f.live={queue:[{placement:'queued',rpcId:'original'}]};
  assert.equal(await adapter.bindRecoveryObservation(A,key,recoveryId),recoveryId);
  assert.deepEqual(await adapter.observe(recoveryId,'original',3),{status:'queued'});
  await assert.rejects(adapter.deliver(recoveryId,'original','不能借观察权重新投'),/授权/);
  await assert.rejects(adapter.recent(recoveryId),/授权/);await assert.rejects(adapter.cursor(recoveryId),/授权/);
  await assert.rejects(adapter.configure(recoveryId,{provider:'p',model:'main'}),/只允许/);
  assert.equal(f.recoveries.length,0);assert.equal(f.prompts.length,0);assert.equal(f.creates.length,0);
  // A newly created client does not inherit a write permission from a journal.
  const reopened=createDshAdapter(remote);await reopened.listSessions([A]);
  assert.equal((await reopened.observe(recoveryId,'original',3)).status,'unknown');
  await reopened.bindRecoveryObservation(A,key,recoveryId);assert.deepEqual(await reopened.observe(recoveryId,'original',3),{status:'queued'});
  await assert.rejects(reopened.cursor(recoveryId),/授权/);
  // An ordinary nonblank candidate, independently authorized by a later
  // roster, MAY receive a same-rpc retry. The read-only proof did not allow it.
  f.rows=[row(recoveryId)];await reopened.listSessions([A]);await reopened.deliver(recoveryId,'original','explicit retry');
  assert.equal(f.prompts.length,1);
});

test('absence from the list is never enough: a negative-only host check cannot grant any access',async()=>{
  const {f,remote,adapter}=emptyFixture(); f.rows=[];await adapter.listSessions([A]);
  const seen=[];remote.routerAgent.recoverEmpty=async req=>{seen.push(req);return ok({sessionId:recoveryId,cursor:3});};
  await assert.rejects(adapter.recoverEmpty(A,key,recoveryId),/无法确认/);await assert.rejects(adapter.cursor(recoveryId));
  assert.deepEqual(seen,[{requestId:key,sessionId:recoveryId,cwd:A,checkMissingOnly:true}]);
  remote.routerAgent.recoverEmpty=async()=>fail('hidden','router-agent/recovery-not-found');
  await assert.rejects(adapter.recoverEmpty(A,key,recoveryId),e=>e.code==='router-agent/recovery-not-found');
  await assert.rejects(adapter.bindRecoveryObservation(A,key,recoveryId));assert.equal(f.states.length,0);assert.equal(f.projectionReads.length,0);assert.equal(f.creates.length,0);assert.equal(f.prompts.length,0);
});
test('both recovery proofs reject invented IDs/keys, malformed, missing, child, archived, or out-of-scope headers before record reads', async () => {
  for (const kind of ['recoverEmpty','bindRecoveryObservation']) {
    const {f,adapter}=emptyFixture();
    await assert.rejects(adapter[kind](A,key,recoveryId));
    await adapter.listSessions([A,B]);
    for(const [cwd,k,id] of [[A,'ra-unsafe-short','session-router-agent-ra-unsafe-short'],[A,'ra-no-uuid',null],
      [A,key,'session-router-agent-another'],[B,key,recoveryId],['/outside',key,recoveryId]]) {
      await assert.rejects(adapter[kind](cwd,k,id));
    }
    for (const rows of [[row(recoveryId,A,{blank:true,origin:'subagent'})],[row(recoveryId,A,{blank:true,parentSessionId:'fork'})],
      [row(recoveryId,A,{blank:true,formatStatus:'migration-required'})],[row(recoveryId,A,{blank:true,agentAvailable:undefined})],
      [row(recoveryId,B,{blank:true})]]) {
      f.rows=rows;await adapter.listSessions([A]);await assert.rejects(adapter[kind](A,key,recoveryId));
    }
    assert.equal(f.recoveries.length,0);assert.equal(f.projectionReads.length,0);assert.equal(f.states.length,0);
    f.rows=[row(recoveryId,A,{blank:true})];await adapter.listSessions([A]);f.archives=[recoveryId];
    await assert.rejects(adapter[kind](A,key,recoveryId),/归档/);assert.equal(f.recoveries.length,0);
    assert.equal(f.projectionReads.length,0);
  }
});

test('lost/invalid recovery response, host denial, changed effective cwd and superseded scope cannot publish a write receipt', async () => {
  for (const reason of ['receipt','cut','no-cut','work','cwd','archive','scope','old-host','denied']) {
    const {adapter,remote,f}=await setupRecovery();
    if(reason==='old-host') delete remote.routerAgent.recoverEmpty;
    else remote.routerAgent.recoverEmpty=async()=>{
      if(reason==='denied') return fail('raw private diagnostic','router-agent/recovery-unsafe');
      if(reason==='cwd') f.exact.set(recoveryId,{kind:'sequenced',asOfSeq:3,values:{workingDirectory:B}});
      if(reason==='archive') f.archives=[recoveryId];
      if(reason==='scope') await adapter.listSessions([B]);
      if(reason==='work') f.log.push(ev('something/changed',{}));
      return ok({sessionId:reason==='receipt'?'unrelated':recoveryId,...(reason==='no-cut'?{}:{cursor:reason==='cut'?-1:3})});
    };
    await assert.rejects(adapter.recoverEmpty(A,key,recoveryId),e=>reason!=='denied' ||
      (e.code==='router-agent/recovery-unsafe' && !e.message.includes('raw private') && e.message.includes('不能证明')));
    await assert.rejects(adapter.deliver(recoveryId,'deny','not sent'));
    await assert.rejects(adapter.configure(recoveryId,{provider:'p',model:'main'}));
    assert.equal(f.prompts.length,0);assert.equal(f.creates.length,0);assert.equal(f.nativeWrites,0);
  }
});

test('after owner confirmation any new event, busy state or uncertain send retires the first-write grant; observe can still reconcile', async () => {
  for (const where of ['cursor','deliver','last-read','busy','uncertain']) {
    const {adapter,remote,f}=await setupRecovery();await adapter.recoverEmpty(A,key,recoveryId);
    if(where==='last-read') {
      const state=remote.session.state;remote.session.state=async(...args)=>{f.log.push(ev('another/event',{}));return state(...args);};
    } else if(where==='busy') f.live={running:true};
    else if(where==='uncertain') remote.session.prompt=async(req)=>{f.prompts.push(req);return fail('回执丢失');};
    else f.log.push(ev('another/event',{}));
    const attempt=where==='cursor'?adapter.cursor(recoveryId):adapter.deliver(recoveryId,'same','原工作');
    await assert.rejects(attempt,where==='uncertain'?/回执丢失/:/新事件或待处理工作/);
    await assert.rejects(adapter.deliver(recoveryId,'same','原工作'),/授权/);
    assert.equal(f.prompts.length,where==='uncertain'?1:0);
    f.live={queue:[{placement:'queued',rpcId:'same'}]};assert.deepEqual(await adapter.observe(recoveryId,'same',3),{status:'queued'});
  }
});

test('readonly bind rechecks fresh directory/cut; pruned rosters and revoked/re-added directories do not revive either grant', async () => {
  for (const mode of ['scope','format','parent','archive','drift']) {
    for (const method of ['recoverEmpty','bindRecoveryObservation']) {
      const {adapter,f}=await setupRecovery();await adapter[method](A,key,recoveryId);
      f.live={queue:[{placement:'queued',rpcId:'key'}]};
      if(mode==='scope') {await adapter.listSessions([B]);await adapter.listSessions([A]);}
      if(mode==='format') {f.rows[0].formatStatus='migration-required';await adapter.listSessions([A]);}
      if(mode==='parent') {f.rows[0].parentSessionId='child';await adapter.listSessions([A]);}
      if(mode==='archive') f.archives=[recoveryId];
      if(mode==='drift') f.exact.set(recoveryId,{kind:'sequenced',asOfSeq:4,values:{workingDirectory:B}});
      assert.equal((await adapter.observe(recoveryId,'key',3)).status,'unknown');
      await assert.rejects(adapter.deliver(recoveryId,'key','must not send'));assert.equal(f.prompts.length,0);
    }
  }
  const {adapter,remote,f}=await setupRecovery();f.log=[];
  await assert.rejects(adapter.bindRecoveryObservation(A,key,recoveryId),/已落地/);
  f.log.push(ev('some/event',{}));const entered=deferred(),release=deferred();
  const projects=remote.session.projections;remote.session.projections=async(...args)=>{entered.resolve();await release.promise;return projects(...args);};
  const binding=adapter.bindRecoveryObservation(A,key,recoveryId);await entered.promise;
  await adapter.listSessions([B]);await adapter.listSessions([A]);release.resolve();await assert.rejects(binding);
  f.live={queue:[{placement:'queued',rpcId:'key'}]};assert.equal((await adapter.observe(recoveryId,'key',0)).status,'unknown');
});

// Previously admitted items are hints, verified against ordinary native
// sessions. They do not use the recovery prefix or create/observation grants.
const route = (id='opaque-native-id',requestId='accepted',afterSeq=-1,cwd=A) => ({id,cwd,requestId,afterSeq});
const exact = (values,asOfSeq=0) => ({kind:'sequenced',asOfSeq,values:{workingDirectory:A,...values}});
test('accepted queue on a blank ordinary session is a busy candidate, without reading unrelated history or claiming a session', async () => {
  const {adapter,f}=fixture(), h=route();
  f.rows=[row(h.id,A,{blank:true}),row('unrelated',A,{blank:true}),row('out',B,{blank:true}),row('archived',A,{blank:true}),
    row('child',A,{blank:true,origin:'subagent'}),row('migration',A,{blank:true,formatStatus:'migration-required'})];f.archives=['archived'];
  f.log=[ev('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[user(h.requestId,'not a transcript yet')]})];
  f.live={queue:[{id:'m',placement:'queued',rpcId:h.requestId}],running:true};
  const hints=[h,route('out','accepted',-1,B),route('archived'),route('child'),route('migration'),route('not-listed')];
  assert.deepEqual((await adapter.listSessions([A],hints)).map(s=>[s.id,s.cwd,s.busy]),[[h.id,A,true]]);
  assert.deepEqual([...new Set(f.projectionReads)],[h.id]);assert.deepEqual(f.states,[h.id]);assert.equal(f.pages.length,0);
  assert.deepEqual(await adapter.recent(h.id),[]); // queue text, internal context and reasoning are never history snippets
  await assert.rejects(adapter.configure(h.id,{provider:'p',model:'main'}),/只允许/);
  await adapter.deliver(h.id,'follow-up','跟进');assert.equal(f.prompts[0].mode,'queue');assert.equal(f.creates.length,0);
  assert.deepEqual(await adapter.listSessions([A]),[]);await assert.rejects(adapter.deliver(h.id,'third','撤销后不发'),/授权/);
});

test('cold queued evidence, a claimed user in its active turn, and later true nonblank projection all admit an ordinary bound row', async () => {
  const {adapter,f}=fixture(),h=route();f.rows=[row(h.id,A,{blank:true,agentAvailable:false,projections:{kind:'cached',asOfSeq:0,values:{}}})];
  const content=user(h.requestId);f.log=[ev('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[content]})];
  f.exact.set(h.id,exact({inbox:{'next-turn':[content],'next-step':[]},sessionListMetadata:{blank:true}}));f.live={active:false,queue:null};
  assert.equal((await adapter.listSessions([A],[h]))[0].busy,true);assert.equal(f.states.length,0);assert.equal(f.pages.length,0);
  f.log.push(start(1),step(1),prompt(h.requestId,'真实人类输入'),ev('user/message',{...user('runtime','内部上下文'),source:{kind:'runtime-context'}},'append'));
  f.exact.set(h.id,exact({sessionListMetadata:{blank:true}},f.log.length-1));f.live={active:true,running:true,queue:[]};
  const active=await adapter.listSessions([A],[h]);assert.equal(active[0].busy,true);assert.deepEqual(await adapter.recent(h.id),['真实人类输入']);
  f.exact.set(h.id,exact({sessionListMetadata:{blank:false}},f.log.length-1));f.live={active:false,queue:null};const before=f.pages.length;
  assert.equal((await adapter.listSessions([A],[h]))[0].id,h.id);assert.equal(f.pages.length,before);
});

test('a journal hint or live busy flag alone cannot promote: ignore wrong cwd, future cursor, unclaimed, mismatched, retracted or untrusted source', async () => {
  const {adapter,f}=fixture(), h=route();f.rows=[row(h.id,A,{blank:true,running:true})];
  f.log=[start(1),step(1),prompt('other'),ev('user/message',{...user(h.requestId),source:{kind:'retry',rpcId:h.requestId}},'append'),
    ev('user/message',user(h.requestId),{op:'replace',startSeq:2,endSeq:2}),assistant(1,'别人的回答')];
  f.live={active:true,running:true,queue:[{placement:'queued',rpcId:'other'},{placement:'steering',rpcId:h.requestId}]};
  assert.deepEqual(await adapter.listSessions([A,B],[route(h.id,'accepted',-1,B)]),[]);assert.equal(f.states.length,0);assert.equal(f.projectionReads.length,0);
  assert.deepEqual(await adapter.listSessions([A],[route(h.id,'accepted',900)]),[]);
  assert.deepEqual(await adapter.listSessions([A],[h]),[]);await assert.rejects(adapter.cursor(h.id),/授权/);
  f.log=[ev('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[user(h.requestId)]}),ev('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[],outcome:'canceled'})];
  f.live={queue:[],running:false};assert.deepEqual(await adapter.listSessions([A],[h]),[]);
  f.log=turn(1,h.requestId,'旧结果');assert.deepEqual(await adapter.listSessions([A],[route(h.id,h.requestId,3)]),[]);
});

test('archive, effective directory drift and a retraction during proof cannot leak candidates or grant later send', async () => {
  for(const problem of ['drift','archive','removed','wrong-format']) {
    const {adapter,remote,f}=fixture(),h=route();f.rows=[row(h.id,A,{blank:true})];
    f.log=[ev('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[user(h.requestId)]})];
    f.live={queue:[{placement:'queued',rpcId:h.requestId}]};
    const state=remote.session.state;
    remote.session.state=async(...args)=>{const v=await state(...args);
      if(problem==='drift') f.exact.set(h.id,exact({workingDirectory:B}));
      if(problem==='archive') f.archives=[h.id];
      if(problem==='removed') f.exact.set(h.id,exact({inbox:{'next-turn':[],'next-step':[]},sessionListMetadata:{blank:true}},1));
      if(problem==='wrong-format') f.exact.set(h.id,{kind:'migration-required',values:{workingDirectory:A}});
      return v;};
    assert.deepEqual(await adapter.listSessions([A,B],[h]),[]);
    await assert.rejects(adapter.deliver(h.id,'lost','不要投递'),/授权/);
  }
});

test('superseded list with the same paths but fewer route bindings cannot restore a withdrawn blank candidate', async () => {
  const {adapter,f,remote}=fixture(),h=route();f.rows=[row(h.id,A,{blank:true})];
  f.log=[ev('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[user(h.requestId)]})];
  f.live={queue:[{placement:'queued',rpcId:h.requestId}]};
  const entered=deferred(),release=deferred(),states=remote.session.state;
  remote.session.state=async(...args)=>{entered.resolve();await release.promise;return states(...args);};
  const previous=adapter.listSessions([A],[h]); await entered.promise;
  assert.deepEqual(await adapter.listSessions([A],[]),[]);release.resolve();await assert.rejects(previous);
  await assert.rejects(adapter.cursor(h.id),/授权/);assert.equal(f.prompts.length,0);
});

test('catalog preserves optional native model labels without inventing speed, ordering or unsupported defaults', async () => {
  const {adapter,f}=fixture();const localized={en:'Popular','zh':'常用'};
  f.modelCatalog.groups[0].models=[{id:'one',name:'Host Fast',description:'Provider description',badge:{tone:'info',text:localized},
    reasoning:{efforts:[{id:'low',name:'Less'},{id:'high',name:'More'}],defaultEffort:'high'}},
    {id:'two',badge:{tone:'warning',text:'Preview'},reasoning:{efforts:[],defaultEffort:'invented'}},
    {id:'three',badge:{tone:'fastest',text:'Not native'},score:1,latency:0}];
  assert.deepEqual(await adapter.catalog(),[{provider:'p',model:'one',efforts:['low','high'],name:'Host Fast',description:'Provider description',badge:{tone:'info',text:localized},defaultEffort:'high'},
    {provider:'p',model:'two',efforts:[],badge:{tone:'warning',text:'Preview'}},{provider:'p',model:'three',efforts:[]}]);
});

test('create accepts a chosen agent preset but omits it to follow the host default; old reply without preset stays compatible', async () => {
  const {adapter,f}=fixture();await adapter.listSessions([A]);
  await adapter.createSession(A,'default');await adapter.createSession(A,'chosen',{agentPreset:'standard'});
  await adapter.createSession(A,'ptc-key',{agentPreset:'ptc'});
  assert.deepEqual(f.creates,[{cwd:A,requestId:'default'},{cwd:A,requestId:'chosen',agentPreset:'standard'},{cwd:A,requestId:'ptc-key',agentPreset:'ptc'}]);
  await assert.rejects(adapter.createSession(A,'bad',{agentPreset:'  '}),/预设/);assert.equal(f.creates.length,3);
  assert.equal(f.nativeWrites,0);assert.equal(f.configs.length,0);
});

// Exact request/turn correlation, including interleaving and partial windows.
test('queued rpcId wins over someone else running/waiting; no session-wide inferred completion', async () => {
  const {adapter,f} = fixture(); await adapter.listSessions([A]);
  f.log=[...turn(1,'other','旧结果'),start(2),step(2),prompt('wait')]; const after=f.log.length-1;
  f.live={running:true,pendingInput:['question'],queue:[{placement:'queued',rpcId:'mine'}]};
  assert.deepEqual(await adapter.observe('a','mine',after),{status:'queued'});assert.equal(f.pages.length,0);
  f.live.queue=[]; assert.equal((await adapter.observe('a','mine',after)).status,'unknown');
  f.live={active:false,running:false,queue:null}; assert.equal((await adapter.observe('a','mine',-1)).status,'unknown');
});

test('cursor pins a contiguous backwards multi-page read; previous or later turns can never supply the result', async () => {
  const {adapter,f} = fixture(); await adapter.listSessions([A]);
  f.log=turn(1,'old','old');const after=await adapter.cursor('a'); assert.equal(after,5);
  f.log.push(...turn(2,'mine','我的最终结果'), ...Array.from({length:19},(_,i)=>turn(i+3,'else-'+i,'不要返回')).flat());
  const got=await adapter.observe('a','mine',after); assert.deepEqual(got,{status:'done',result:'我的最终结果'});
  assert.ok(f.pages.length>1);const cut=f.log.length-1;
  assert.ok(f.pages.every(p=>p.throughSeq===cut&&p.address.sessionId==='a'));
  assert.ok(f.pages.slice(1).every(p=>Number.isInteger(p.beforeSeq)));
  assert.equal((await adapter.observe('a','old',after)).status,'unknown');
});

test('unfinished turn is running or requests input only for the confirmed owner; no partial text on idle/unknown', async () => {
  const {adapter,f} = fixture(); await adapter.listSessions([A]);
  f.log=[start(1),step(1),prompt('mine'),assistant(1,'计划中'),ev('tool/call',{turn:1,step:1,name:'ask_user_question',callId:'q'})];
  f.live={running:true};assert.deepEqual(await adapter.observe('a','mine',-1),{status:'running'});
  f.live.pendingInput=['question'];assert.deepEqual(await adapter.observe('a','mine',-1),{status:'input-required'});
  assert.equal((await adapter.observe('a','unrelated',-1)).status,'unknown');
  f.live.running=false; const state=await adapter.observe('a','mine',-1);assert.equal(state.status,'unknown');assert.equal(state.result,undefined);
});

test('mixed human inputs, replacement-only correlation, missing start, wrong-turn output and duplicate rpc are ambiguous', async () => {
  const {adapter,f} = fixture(); await adapter.listSessions([A]);
  for (const log of [
    [start(1),step(1),prompt('other'),prompt('mine'),assistant(1,'联合结果'),end(1)],
    [start(1),step(1),ev('user/message',user('mine'),{op:'replace',startSeq:0,endSeq:0}),assistant(1,'旧'),end(1)],
    [prompt('mine'),assistant(9,'无轮次'),end(9)],
    [start(1),step(1),prompt('mine'),assistant(2,'错轮'),end(1)],
    [start(1),step(1),prompt('mine'),assistant(1,'尚无终态'),start(2),...turn(3,'other','后续')],
    [...turn(1,'mine','one'),...turn(2,'mine','duplicate')],
  ]) { f.log=log;const state=await adapter.observe('a','mine',-1);assert.equal(state.status,'unknown');assert.equal(state.result,undefined); }
});

test('completed tool/attempt/interrupted/reasoning-only final step does not promote old or hidden text; durable errors stay failures', async () => {
  const {adapter,f} = fixture(); await adapter.listSessions([A]);
  const base=[start(1),step(1),prompt('mine'),assistant(1,'我接下来会检查…'),stepEnd(1),step(1,2)];
  for (const tail of [assistant(1,[txt('中间话'),{type:'tool-call',name:'read'}],2),
    assistant(1,[{type:'reasoning',text:'隐藏'}],2),assistant(1,'半截',2,{interrupted:true}),
    ev('assistant/attempt',{turn:1,step:2,stream:[{text:'partial'}]}),assistant(1,' '.repeat(17000),2)]) {
    f.log=[...base,tail,stepEnd(1,2),end(1)];const state=await adapter.observe('a','mine',-1);assert.equal(state.status,'unknown');assert.equal(state.result,undefined);
  }
  f.log=[...base,assistant(1,[{type:'reasoning',text:'不要返回'},txt('最终'),txt('！')],2),stepEnd(1,2),end(1)];
  assert.deepEqual(await adapter.observe('a','mine',-1),{status:'done',result:'最终！'});
  for (const kind of ['aborted','error','max-tokens','blocked','interrupted','forked']) {
    f.log=[...turn(1,'mine','半截').slice(0,-1),end(1,kind,kind==='error'?{error:{message:'供应商不可用'}}:{})];
    const state=await adapter.observe('a','mine',-1);assert.equal(state.status,'failed');assert.equal(state.result,undefined);if(kind==='error')assert.match(state.error,/供应商不可用/);
  }
});

test('history gaps, wrong cuts, invalid bounds and carrier errors report unknown, never failed/done', async () => {
  const {adapter,f,remote} = fixture(); await adapter.listSessions([A]);f.log=turn(1,'mine','不要返回');
  assert.equal((await adapter.observe('a','mine',null)).status,'unknown');
  assert.equal((await adapter.observe('a','mine',60)).status,'unknown');
  const real=remote.session.events;
  remote.session.events=async (...args)=>{const v=await real(...args);v.value.records.splice(2,1);return v;};
  assert.equal((await adapter.observe('a','mine',-1)).status,'unknown');
  remote.session.events=async (...args)=>{const v=await real(...args);v.value.cursor--;return v;};
  assert.equal((await adapter.observe('a','mine',-1)).status,'unknown');
  remote.session.events=async()=>fail('连接不可用');const x=await adapter.observe('a','mine',-1);assert.equal(x.status,'unknown');assert.match(x.error,/连接不可用/);
});
