import { ROUTE_MODES, isRouteMode } from '../core/route-mode.mjs';
import { SESSION_MODES, shortDir, copySettings, checkSettings, directoryOptions, options, text, val, msg, order } from './shared.mjs';
import { createModelEditor } from './model-settings.mjs';

export function createSettings(ctx) {
  const {el, button, field, live} = ctx.ui;
  const memory = ctx.memory;
  const form = el('form','rt-settings'); form.noValidate = true;
  const top = el('div','rt-section-head'), heading = el('h2'), topline=el('p','rt-muted');
  top.append(heading,topline);
  const grid = el('div','rt-settings-grid'), dirs=el('section','rt-card'), tiers=el('section','rt-card');
  const general = el('input'); general.placeholder='/Users/me/Work/general'; general.autocomplete='off'; general.spellcheck=false;
  const knownGeneral=el('select'), knownProject=el('select'), defaultProject=el('select'), routeMode=el('select'), routeHint=el('p','rt-muted');
  const knownGeneralField=field('或从已知工作区填入通用目录',knownGeneral);
  const knownProjectField=field('从已知工作区添加项目',knownProject);
  const projectList=el('div','rt-projects'), projectRows=new Map(), fields=new Map();
  const emptyProjects=el('p','rt-muted','尚未添加项目。只使用通用目录也可以开始。');
  const add = button('＋ 手动添加项目目录',() => addRow({name:'',path:''}));
  const dirHint=el('p','rt-muted','只会在以下已授权的目录中选择。可手填 DSH 主机上的精确绝对路径，不要求已有会话。');
  dirs.append(el('p','rt-eyebrow','01 / 目录'),el('h3','','任务可以去哪里'),field('工作区与会话路由',routeMode),routeHint,dirHint,field('通用目录（必填）',general),knownGeneralField,
    el('hr'),el('h4','','项目目录'),el('p','rt-muted','项目名用于匹配任务；留空时使用目录名。'),knownProjectField,projectList,emptyProjects,add,el('hr'),field('未指名项目时的默认项目',defaultProject),
    el('p','rt-muted','默认项目只用于兜底，不覆盖点名的目标或有充分线索的项目。通用问答、写作优先使用通用目录。'));
  const unavailable=live();
  tiers.append(el('p','rt-eyebrow','02 / 执行档位'),el('h3','','按任务选择模型'),
    el('p','rt-muted','按任务复杂度选档，只使用 DSH 当前可用的模型与思考强度。意图分类使用「快速」档；不可用时仍按所选的本地路由策略判断。'),unavailable);
  const editor=createModelEditor(ctx,draft,()=>{changed();update();});
  const preset=el('select'), modeBox=el('section','rt-creation-mode');
  modeBox.append(el('h4','','创建预设'),el('p','rt-muted','仅用于新会话，不改动任何已有会话或 DSH 全局默认。预设与模型档位、权限审批相互独立。所选预设不可用时停止，不会悄悄换成另一种模式。'),field('新会话模式',preset));
  preset.addEventListener('change',()=>{if(SESSION_MODES.has(preset.value)){draft().value.sessionMode=preset.value;changed();}});
  tiers.append(editor.node,modeBox);
  const feedback=live(), conflict=live(), footer=el('div','rt-settings-foot'), footActions=el('div','rt-actions');
  const save=el('button','rt-btn rt-primary','保存设置'); save.type='submit';
  const reset=button('载入已保存的设置',() => {
    memory.settings=null; msg(feedback,'已载入保存值，先前的设置草稿已放弃。'); ctx.paint();
  },'rt-btn rt-quiet');
  const localNote=el('p','rt-muted','供个人跨项目使用。设置与任务记录保存在本机当前浏览器的 DSH 入口。');
  footActions.append(reset,save); footer.append(localNote,footActions); grid.append(dirs,tiers); form.append(top,conflict,grid,feedback,footer);
  form.addEventListener('submit',e=>{e.preventDefault(); saveDraft();});
  general.addEventListener('input',()=>{draft().value.generalDir=general.value; changed();});
  knownGeneral.addEventListener('change',()=>{ if (knownGeneral.value) {draft().value.generalDir=knownGeneral.value; changed(); update(); general.focus();} });
  routeMode.addEventListener('change',()=>{if(isRouteMode(routeMode.value)){draft().value.routingMode=routeMode.value;changed();update();}});
  defaultProject.addEventListener('change',()=>{
    const v=draft().value,path=defaultProject.value;
    if(!path || directoryOptions(v.projects).some(row=>row.value===path)){v.defaultProject=path;changed();}
  });
  knownProject.addEventListener('change',()=>{
    const ws=ctx.state.workspaces.find(w=>w.path===knownProject.value);
    if (!ws) return;
    if (draft().value.projects.some(p=>p.path.trim()===ws.path)) { msg(feedback,'这个工作区已在项目目录中。'); val(knownProject,''); return; }
    addRow({name:ws.name || shortDir(ws.path),path:ws.path});
  });
  function addRow(row) {
    draft().value.projects.push(row); changed(); update(); projectRows.get(row).path.focus();
  }
  function draft() {
    const value=copySettings(ctx.state.settings), stamp=JSON.stringify(value);
    if (!memory.settings || (!memory.settings.dirty && memory.settings.base!==stamp)) {
      memory.settings={value,base:stamp,rev:0,dirty:false};
    }
    return memory.settings;
  }
  function changed() {
    const d=draft(); d.dirty=true; d.rev++; reset.hidden=false;
    for (const control of fields.values()) control.removeAttribute('aria-invalid');
    msg(feedback); ctx.markSettingsDirty();
  }
  function updateDefaultProject(v, clearRemoved=false) {
    const entries=directoryOptions(v.projects); const removed=v.defaultProject && !entries.some(e=>e.value===v.defaultProject);
    if(removed && clearRemoved) v.defaultProject='';
    else if(removed) entries.push({value:v.defaultProject,label:v.defaultProject+'（已不在项目中）',disabled:true});
    options(defaultProject,entries,v.defaultProject,v.routingMode==='auto'?'留空 · 使用自动兜底':'留空 · 无法判断时询问');fields.set('defaultProject',defaultProject);
    if(removed && clearRemoved) msg(feedback,'原默认项目已不在项目目录中，现已清空。');
  }
  function rowView(row) {
    const box=el('div','rt-project-row'); const name=el('input'),path=el('input'); path.spellcheck=false;
    name.placeholder='例如：个人网站'; path.placeholder='/Users/me/Work/site';
    const remove=button('移除',()=>{
      const rows=draft().value.projects; rows.splice(rows.indexOf(row),1); changed(); updateDefaultProject(draft().value,true); update(); add.focus();
    },'rt-btn rt-quiet');
    box.append(field('项目名（选填）',name),field('项目绝对目录',path),remove);
    for (const [key,n] of [['name',name],['path',path]]) n.addEventListener('input',()=>{row[key]=n.value; changed(); updateDefaultProject(draft().value,key==='path');});
    return {box,name,path,remove};
  }
  function saveDraft() {
    const d=draft(), rev=d.rev;
    const {data,field:bad,error}=checkSettings(d.value,ctx.models,ctx.state.catalog);
    if (error) {
      msg(feedback,error,'red'); const input=fields.get(bad); input?.setAttribute('aria-invalid','true'); input?.focus(); return;
    }
    ctx.run(feedback,'保存设置',()=>ctx.api.saveSettings(data),()=>{
      if (d.rev!==rev) return '设置已保存；保存期间的新编辑仍是草稿。';
      memory.settings=null; // Reopen using the host-normalized snapshot, not the submitted draft.
      ctx.goBoard(); return '设置已保存。';
    });
  }
  function update() {
    const d=draft(), value=d.value, wsRows=directoryOptions(ctx.state.workspaces);
    text(heading,ctx.ready ? '路由设置' : '配置你的任务路由');
    text(topline,ctx.ready ? '目录决定任务去哪里，档位决定使用哪个模型。' : '先选通用目录，再确认新会话的模型与模式。');
    fields.clear(); fields.set('generalDir',general); val(general,value.generalDir);
    options(knownGeneral,wsRows,'','选择工作区…'); options(knownProject,wsRows,'','选择工作区…');
    knownGeneralField.hidden=knownProjectField.hidden=!wsRows.length;
    emptyProjects.hidden=!!value.projects.length;
    const nodes=value.projects.map((row,i)=>{
      if (!projectRows.has(row)) projectRows.set(row,rowView(row));
      const r=projectRows.get(row); val(r.name,row.name); val(r.path,row.path); fields.set('project:'+i,r.path);
      r.remove.setAttribute('aria-label','移除项目 '+(row.name || row.path || (i+1))); return r.box;
    });
    order(projectList,nodes); for (const row of projectRows.keys()) if (!value.projects.includes(row)) projectRows.delete(row);
    const routes=Object.entries(ROUTE_MODES).map(([value,label])=>({value,label}));
    if(!isRouteMode(value.routingMode)) routes.push({value:value.routingMode,label:'未知路由策略（请重新选择）',disabled:true});
    options(routeMode,routes,value.routingMode);fields.set('routingMode',routeMode);
    text(routeHint,value.routingMode==='auto'?'有同一工作的依据就续接，否则自动选择目录新建。项目任务缺少线索时，使用默认项目；未设默认则使用项目列表首项。目标冲突、没有获准目录或找不到所指的旧会话时才需要选择。':'仍自动处理明确的目标；项目或旧会话证据不足时，停在「待选择」。');
    updateDefaultProject(value);editor.update(value,fields);
    const modes=[...SESSION_MODES].map(([value,label])=>({value,label}));
    if(!SESSION_MODES.has(value.sessionMode)) modes.push({value:value.sessionMode,label:(value.sessionMode || '空值')+'（当前不支持）',disabled:true});
    options(preset,modes,value.sessionMode);fields.set('sessionMode',preset);
    msg(unavailable,ctx.loaded && !ctx.models.length ? '未取得可用模型。请检查 DSH 提供方配置与授权，然后刷新；不会替你猜测模型。' : '','amber');
    msg(conflict,d.dirty && d.base!==JSON.stringify(copySettings(ctx.state.settings)) ? '保存值已有更新。你的草稿已保留，可载入保存值，或检查草稿后保存。' : '','amber');
    const pending=ctx.busy(feedback); save.disabled=!ctx.online || pending; text(save,pending?'正在保存…':'保存设置');
    reset.hidden=!d.dirty; reset.disabled=pending;
  }
  return {node:form,update};
}
