import test from 'node:test';
import assert from 'node:assert/strict';
import { groupLedger } from '../src/ui/ledger-groups.mjs';
import { STATUS, matchesFilter } from '../src/ui/shared.mjs';

const A = '/alpha/site', B = '/beta/site', G = '/general';
const settings = () => ({projects: [{path:A, name:'网站'}, {path:B, name:'网站'}], generalDir:G, defaultProject:A});
const snapshot = (tasks, sessions = []) => ({settings:settings(), tasks, sessions, connected:true});
const demand = (id, createdAt, items, text = id) => ({id, createdAt, text, items});
const item = (project, sessionId, status, extra = {}) => ({project, sessionId, status, ...extra});
const at = (groups, path) => groups.find(p => p.path === path);
const session = (p, sid) => p.sessions.find(s => s.sid === sid);
const allTasks = groups => groups.flatMap(p => p.sessions.flatMap(s => s.tasks));
const ids = rows => rows.map(t => t.id);
const counts = s => [s.count, s.attention, s.active];
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}

test('项目按精确目录，会话按真实绑定；同名分开，另次提交各占一条，追问不另计', () => {
  const first = demand('first', 10, [item(A, 's:1', 'done', {id:'root', decision:'create'}),
    item(A, 's:1', 'input-required', {id:'f1', parentItemId:'root'}),
    item(A, 's:1', 'queued', {id:'f2', parentItemId:'f1'})]);
  const later = demand('later', 40, [item(A, 's:1', 'running', {decision:'reuse'})]);
  const other = demand('other', 20, [item(A, 's:2', 'failed')]);
  const elsewhere = demand('elsewhere', 30, [item(B, 's:3', 'done')]);
  const state = freeze(snapshot([other, later, elsewhere, first], [
    {id:'s:1', cwd:A, title:'同名对话'}, {id:'s:2', cwd:A, title:'同名对话'},
    {id:'s:3', cwd:B, title:'同名对话'}, {id:'no-record', cwd:G, title:'仅在原生列表'},
  ]));
  const tree = groupLedger(state);
  assert.deepEqual(tree.map(p => [p.label, p.detail]), [['网站', A], ['网站', B]]);
  assert.notEqual(tree[0].key, tree[1].key);
  const [p, q] = tree, [s1, s2] = p.sessions;
  assert.deepEqual(p.sessions.map(s => [s.sid, s.label, s.detail]), [['s:1','同名对话','s:1'], ['s:2','同名对话','s:2']]);
  assert.notEqual(s1.key, s2.key); assert.equal(p.sessionCount, 2); assert.equal(q.sessionCount, 1);
  assert.deepEqual(counts(p), [3, 1, 2]); assert.deepEqual(counts(s1), [2, 1, 2]);
  assert.deepEqual(ids(s1.tasks), ['later', 'first']); assert.equal(s1.tasks[1], first);
  assert.equal(s1.tasks[1].items.length, 3); assert.equal(new Set(allTasks(tree)).size, 4);
  assert.deepEqual(ids(state.tasks), ['other','later','elsewhere','first']); // no in-place sorting or migration
});

test('按最近匹配需求排序，以未过滤的首条本地需求为无标题会话命名；刷新和筛选不改 key', () => {
  const sid = 'session-router-agent-ra-' + 'x'.repeat(120);
  const state = snapshot([
    demand('z', '30', [item(A, sid, 'queued')]), demand('only-b', 80, [item(B, 'b', 'queued')]),
    demand('latest', 100, [item(A, sid, 'done')]), demand('only-y', 40, [item(A, 'y', 'queued')]),
    demand('origin', new Date(10).toISOString(), [item(A, sid, 'done')], ' 首条\n  本地需求 '),
    demand('a', 30, [item(A, sid, 'queued')]),
  ], [{id:sid, cwd:A, title:sid, updatedAt:99999}]);
  const initial = groupLedger(state), filtered = groupLedger(state, 'queued');
  assert.deepEqual(initial.map(p => p.path), [A,B]); assert.deepEqual(filtered.map(p => p.path), [B,A]);
  assert.deepEqual(initial[0].sessions.map(s => s.sid), [sid,'y']);
  assert.deepEqual(filtered[1].sessions.map(s => s.sid), ['y',sid]);
  const a = session(initial[0], sid), b = session(filtered[1], sid);
  assert.equal(a.label, '首条 本地需求'); assert.equal(a.label,b.label); assert.equal(b.detail,sid);
  assert.equal(initial[0].key, filtered[1].key); assert.equal(a.key,b.key);
  assert.deepEqual(ids(b.tasks), ['a','z']); assert.deepEqual(counts(filtered[1]), [3,0,3]);
  assert.deepEqual(groupLedger({...state,tasks:state.tasks.slice().reverse()}),initial);
  state.sessions[0].title = 'session-router-guide'; state.settings.projects[0].name = '项目新名称';
  const renamed = at(groupLedger(state), A); assert.equal(renamed.label, '项目新名称');
  assert.equal(renamed.key,initial[0].key); assert.equal(session(renamed,sid).key,a.key);
  assert.equal(session(renamed,sid).label, 'session-router-guide'); // an actual title, not this session's ID fallback
});

test('澄清推荐不是目录确认；未绑定的创建/失败归已选项目，默认目录、候选和恢复提示都不授予身份', () => {
  const suggestion = item(A, null, 'clarify', {decision:'clarify', candidates:['x'], candidateDirs:{x:A},
    expectedSessionId:'x', routeSuggestion:{kind:'reuse', sessionId:'x', project:A}, reason:'已推荐这个项目'});
  const state = snapshot([
    demand('reviewed',5,[suggestion]), demand('before-review',4,[item(A,null,'new',{decision:'clarify'})]),
    demand('no-project',3,[item(null,'x','done')]), demand('no-items',2,[]),
    demand('creating',6,[item(A,null,'dispatching',{decision:'create',expectedSessionId:'x'})]),
    demand('failed',7,[item(A,null,'failed',{decision:'create',recoverableEmpty:true,expectedSessionId:'x'})]),
    demand('general',1,[item(G,null,'new',{decision:'create'})]),
  ], [{id:'x',cwd:A,title:'私有原生标题'}]);
  const tree = groupLedger(state), pending = at(tree,null), known = at(tree,A), general = at(tree,G);
  assert.equal(pending.label,'待归属'); assert.deepEqual(ids(pending.sessions[0].tasks), ['reviewed','before-review','no-project','no-items']);
  assert.deepEqual(ids(known.sessions[0].tasks), ['failed','creating']); assert.deepEqual(counts(known), [2,0,1]);
  assert.equal(general.label,'通用目录'); assert.equal(general.detail,G);
  for (const p of tree) {
    assert.equal(p.sessionCount,0); assert.equal(p.sessions.length,1); assert.equal(p.sessions[0].label,'未绑定会话');
    assert.equal(p.sessions[0].sid,null); assert.ok(!p.sessions[0].detail.includes('私有原生标题'));
  }
  assert.notEqual(known.sessions[0].key,pending.sessions[0].key); // same placeholder label across projects
  // Genuine resolve-to-create and subsequent host binding move the same original demand.
  suggestion.decision = 'create'; suggestion.status = 'dispatching';
  assert.ok(at(groupLedger(state),A).sessions[0].tasks.includes(state.tasks[0]));
  suggestion.sessionId = 'x';
  assert.equal(session(at(groupLedger(state),A),'x').tasks[0],state.tasks[0]);
});

test('同 sid 另一 cwd、撤权、离线与冲突 roster 不借实时标题，仍保留原目录本机历史', () => {
  const past = '/revoked/site', sid = 'same';
  const state = snapshot([demand('old',1,[item(past,sid,'done')],'原目录本机需求'),
    demand('now',2,[item(A,sid,'done')],'现目录本机需求')], [{id:sid,cwd:A,title:'只属于现目录的标题'}]);
  const tree = groupLedger(state), old = at(tree,past), current = at(tree,A);
  assert.equal(old.label,'site'); assert.equal(old.detail,past);
  assert.equal(old.sessions[0].label,'原目录本机需求'); assert.equal(current.sessions[0].label,'只属于现目录的标题');
  assert.equal(old.sessions[0].sid,sid); assert.notEqual(old.sessions[0].key,current.sessions[0].key);
  const offline = at(groupLedger({...state,connected:false}),A).sessions[0];
  assert.equal(offline.key,current.sessions[0].key); assert.equal(offline.label,'现目录本机需求');
  // Matching revoked cwd still has no authority. A spelling variant is not the saved path either.
  for (const cwd of [past,A+'/']) {
    const groups = groupLedger({...state,sessions:[{id:sid,cwd,get title(){throw Error('越过目录读取了原生标题');}}]});
    assert.equal(at(groups,past).sessions[0].label,'原目录本机需求'); assert.equal(at(groups,A).sessions[0].label,'现目录本机需求');
  }
  const ambiguous = groupLedger({...state,sessions:[...state.sessions,{id:sid,cwd:B,title:'冲突条目'}]});
  assert.equal(at(ambiguous,A).sessions[0].label, '现目录本机需求');
});

test('旧图不拆不重记；同项目多会话、跨项目/混合各有占位，统一真实绑定可普通归类', () => {
  const sameProject = demand('两个会话',4,[item(A,'s','done'),item(A,'t','running')]);
  const cross = demand('跨目录',5,[item(A,'s','done'),item(B,'s','queued')]);
  const mixed = demand('部分绑定',6,[item(A,'s','done'),item(A,null,'waiting')]);
  const undecided = demand('部分待选',2,[item(A,'s','done'),item(A,null,'clarify')]);
  const ordinary = demand('统一绑定',3,[item(A,'s','done'),item(A,'s','done',{dependsOn:['item-1']})]);
  const unbound = demand('尚无绑定',1,[item(A,null,'dispatching'),item(A,null,'failed')]);
  const state = snapshot([ordinary,unbound,cross,undecided,sameProject,mixed]);
  const all = groupLedger(state), done = groupLedger(state,'done');
  for (const tree of [all, done]) {
    const p = at(tree,A), history = at(tree,null), multi = p.sessions.find(s => s.label==='历史多会话');
    assert.equal(history.label,'历史多目标'); assert.equal(history.sessionCount,0); assert.equal(history.sessions.length,1);
    assert.equal(history.sessions[0].label,'多目标需求'); assert.equal(history.sessions[0].sid,null);
    assert.deepEqual(history.sessions[0].tasks,[cross,undecided]); assert.deepEqual(counts(history),[2,1,1]);
    const partial = p.sessions.find(s => s.label==='会话未统一');
    assert.equal(partial.sid,null); assert.deepEqual(partial.tasks,[mixed]); assert.notEqual(partial.key,multi.key);
    assert.equal(p.sessionCount,1); assert.equal(multi.sid,null); assert.deepEqual(multi.tasks,[sameProject]);
    assert.deepEqual(session(p,'s').tasks,[ordinary]); assert.ok(!at(tree,B));
    assert.equal(new Set(allTasks(tree)).size, allTasks(tree).length);
  }
  assert.equal(allTasks(all).length,6); assert.equal(allTasks(done).length,5);
  assert.deepEqual(session(at(groupLedger(state,'running'),A),null).tasks,[sameProject]);
  assert.equal(at(all,null).sessions[0].key,at(done,null).sessions[0].key);
  const sharedUnknown = demand('目录未知',1,[item(null,'s','done'),item(null,null,'new')]);
  const conflict = demand('目录未知且不同会话',2,[item(null,'s','done'),item(null,'t','new')]);
  const unknown = groupLedger(snapshot([sharedUnknown,conflict]));
  assert.deepEqual(unknown.map(p => [p.label,p.sessions[0].sid,p.sessions[0].tasks[0]]),
    [['历史多目标',null,conflict],['待归属',null,sharedUnknown]]);
  assert.notEqual(unknown[0].sessions[0].key,unknown[1].sessions[0].key);
});

test('筛选与原状态语义一致；空记录、无效时间与畸形字段可浏览，不制造权限或空项目', () => {
  for (const value of [null, undefined, false, {}, {tasks:'bad'}, snapshot([])]) assert.deepEqual(groupLedger(value),[]);
  const rows = [demand('empty',null,[]), demand('odd-items','?',{}), demand('unknown',0,[null]),
    demand('bad-path',false,[item('/q/../a','x','bad-status')]), demand('bad-sid',{},[item(A,'wrong\nid','done')]),
    demand('mixed-status',-1,[item(A,'unbound','queued'),item(A,'unbound','queued'),item(A,'unbound','input-required')]),
    demand('filtered',-2,[item(B,'__proto__','done')])];
  const state = snapshot([null, false, [], 'bad-task', ...rows]);
  for (const filter of ['', ...STATUS.keys(), 'not-a-status']) {
    const tree = groupLedger(state,filter), expected = rows.filter(t => matchesFilter(t,filter));
    assert.deepEqual(ids(allTasks(tree)).sort(),ids(expected).sort(),filter);
    assert.equal(tree.reduce((n,p) => n+p.count,0),expected.length);
    for (const p of tree) {
      assert.equal(p.count,p.sessions.reduce((n,s) => n+s.count,0));
      assert.equal(p.sessionCount,p.sessions.filter(s=>s.sid!==null).length);
    }
  }
  const tree = groupLedger(state), p = at(tree,A);
  assert.deepEqual(counts(session(p,'unbound')),[1,1,1]); // demand with multiple matching statuses still counts once
  assert.deepEqual(ids(session(p,null).tasks),['bad-sid']); assert.notEqual(session(p,null).key,session(p,'unbound').key);
  assert.equal(at(tree,null).label,'待归属'); assert.equal(at(tree,null).sessions[0].tasks[0].id,'unknown');
});

test('标题有界且不切开字符，原始长文和同 basename 目录保持完整；不读取其他数据源', () => {
  const raw = '🐈'.repeat(1000), path = '/历史/site';
  const state = {tasks:[demand('local',4,[item(path,'long','done')],raw),demand('native',2,[item(A,'native','done')]),
      demand('old-basename',3,[item('/另一个/site','long','done',{text:'首条分项摘要'})],''), demand('untitled',5,[item(B,'missing','done')],'')],
    settings:settings(), sessions:[{id:'native',cwd:A,title:raw}, {id:'other',cwd:B,get title(){throw Error('读取了无记录的原生标题');}}],
    get workspaces(){throw Error('读取了未使用的工作区');}, get catalog(){throw Error('读取了未使用的模型目录');}};
  const tree = groupLedger(state), local = at(tree,path).sessions[0], native = at(tree,A).sessions[0];
  assert.ok(local.label.endsWith('…') && Array.from(local.label).length<=80);
  assert.equal(local.label,native.label); assert.match(local.label,/^🐈+…$/u); assert.equal(local.tasks[0].text,raw);
  const second = at(tree,'/另一个/site'); assert.equal(at(tree,path).label,second.label); assert.notEqual(at(tree,path).detail,second.detail);
  assert.equal(second.sessions[0].label,'首条分项摘要'); assert.notEqual(local.key,second.sessions[0].key);
  assert.equal(at(tree,B).sessions[0].label,'未命名会话'); assert.equal(at(tree,B).sessions[0].detail,'missing');
});
