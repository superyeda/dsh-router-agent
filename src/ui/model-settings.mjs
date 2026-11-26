import {TIERS, pairKey, options, text, msg, previewModels, modelLabel} from './shared.mjs';

/** This editor changes drafts, never runtime configuration. The automatic preview is read-only. */
export function createModelEditor(ctx, draft, edited) {
  const {el,button,field,live}=ctx.ui;
  const copyTiers=tiers=>Object.fromEntries(TIERS.map(([k])=>[k,{...tiers[k]}]));
  const node=el('div','rt-model-editor'), mode=el('select'), provider=el('select');
  const auto=el('section','rt-action-box'), manual=el('div'), migration=live(), warning=live(), reason=live();
  const available=live(), preview=el('dl','rt-preview-models');
  const autoFields=new Map(), manualFields=new Map();
  const explain=el('p','rt-muted','选择一个提供方会把三个自动档都绑定到它；也可沿用各档原提供方。切换策略不会覆盖手动三档；保存后只用于新建会话。');
  auto.append(field('自动档位的提供方',provider),explain,el('h4','','当前三档预览'),preview,reason,available);
  for (const [key,title,hint] of TIERS) {
    const row=el('div'), val=el('dd');row.append(el('dt','rt-label',title),val);preview.append(row);autoFields.set(key,val);
    const block=el('fieldset','rt-tier'), selects=el('div','rt-model-grid'), model=el('select'), effort=el('select');
    selects.append(field(title+'档模型',model),field(title+'档思考强度',effort));
    block.append(el('legend','',title),el('p','rt-muted',hint),selects);manual.append(block);manualFields.set(key,{model,effort});
    model.addEventListener('change',()=>{
      const v=draft().value; if (v.modelMode!=='manual') return;
      const picked=ctx.models.find(m=>m.key===model.value);const old=v.tiers[key];
      v.tiers[key]={provider:picked?.provider || '',model:picked?.model || '',effort:picked?.efforts.includes(old.effort)?old.effort:''};edited();
    });
    effort.addEventListener('change',()=>{const v=draft().value;if(v.modelMode==='manual'){v.tiers[key].effort=effort.value;edited();}});
  }
  const clone=button('按此预览转为手动编辑',()=>{
    const v=draft().value;if(v.modelMode!=='auto')return;
    const plan=previewModels(v,ctx.models,ctx.state.catalog);if(!plan.tiers)return;
    // This explicit action is the only mode switch that replaces all three manual choices.
    v.tiers=copyTiers(plan.tiers);v.modelMode='manual';edited();mode.focus();
  }); auto.append(clone);
  mode.addEventListener('change',()=>{
    if (['auto','manual'].includes(mode.value)) {draft().value.modelMode=mode.value;edited();}
  });
  provider.addEventListener('change',()=>{
    const v=draft().value, target=provider.value;
    if(v.modelMode==='auto' && (!target || ctx.models.some(m=>m.provider===target))) {v.autoProvider=target;edited();}
  });
  node.append(field('新会话模型分配',mode),migration,auto,manual,warning);
  function update(v,fields) {
    const useAuto=v.modelMode==='auto';
    const modes=[{value:'auto',label:'自动 · 按任务复杂度分档'},{value:'manual',label:'手动 · 固定三个档位'}];
    if(!modes.some(m=>m.value===v.modelMode)) modes.push({value:v.modelMode,label:(v.modelMode || '空值')+'（未知策略）',disabled:true});
    options(mode,modes,v.modelMode);
    fields.set('modelMode',mode);auto.hidden=!useAuto;manual.hidden=useAuto;
    const original=ctx.state.settings, oldRows=TIERS.map(([k])=>original.tiers?.[k]);
    const same=rows=>rows.every(t=>t?.provider && t.model) && new Set(rows.map(t=>JSON.stringify([t.provider,t.model,t.effort || '']))).size===1;
    msg(migration,!original.modelMode && same(oldRows) && useAuto?'旧设置的三档原本完全相同。升级后按自动策略预览；如需保持原值，请选「手动」并保存。':'');
    const providers=[...new Set(ctx.models.map(m=>m.provider))], source=[...new Set(TIERS.map(([k])=>v.tiers[k].provider).filter(Boolean))];
    const rows=providers.map(value=>({value,label:value}));
    if (v.autoProvider && !providers.includes(v.autoProvider)) rows.push({value:v.autoProvider,label:v.autoProvider+'（当前不可用）',disabled:true});
    options(provider,rows,v.autoProvider, source.length ? '沿用各档原提供方：'+source.join('、') : '请选择提供方…');
    provider.disabled=!providers.length;fields.set('autoProvider',provider);
    const tierRows=TIERS.map(([k])=>v.tiers[k]);
    msg(warning,!useAuto && same(tierRows)?'手动三档配置完全相同：不同复杂度目前会使用同一模型与思考强度。可保留，或切换到自动。':'','amber');
    if (useAuto) {
      const plan=previewModels(v,ctx.models,ctx.state.catalog), effective=plan.tiers;
      for (const [key] of TIERS) {const t=effective?.[key] || plan.partial?.[key];text(autoFields.get(key),t?modelLabel(t):'尚无可用预览');}
      msg(reason,plan.error || '',ctx.models.length && !v.autoProvider && !source.length?'info':'amber');clone.disabled=!effective;
      const allowed=v.autoProvider?[v.autoProvider]:source, count=ctx.models.filter(m=>allowed.includes(m.provider)).length;
      const flat=!!effective && same(TIERS.map(([k])=>effective[k]));
      msg(available,effective && count===1 ? (flat?'范围内只有一个可用模型，三档使用相同模型与思考强度。':'范围内只有一个可用模型；三档共用该模型，可用的思考强度见预览。') : flat?'当前策略为三档选中了相同配置。可切换到手动，查看并固定其他可用组合。':'','info');
      // Do not populate three large, hidden model menus on every automatic-mode refresh.
      for (const {model,effort} of manualFields.values()) model.disabled=effort.disabled=true;
      return;
    }
    for (const [key] of TIERS) {
      const {model,effort}=manualFields.get(key), t=v.tiers[key], selected=t.model?pairKey(t.provider,t.model):'';
      const cap=ctx.models.find(m=>m.key===selected), choices=ctx.models.map(m=>({value:m.key,label:m.provider+' / '+m.model}));
      if(selected && !cap)choices.push({value:selected,label:t.provider+' / '+t.model+'（当前不可用）',disabled:true});
      options(model,choices,selected,'选择模型…');model.disabled=useAuto || !ctx.models.length;
      const strengths=(cap?.efforts || []).map(s=>({value:s,label:s}));
      if(t.effort && !cap?.efforts.includes(t.effort)) strengths.push({value:t.effort,label:t.effort+'（当前不可用）',disabled:true});
      options(effort,strengths,t.effort,cap?'模型默认':'请先选择模型');effort.disabled=useAuto || !cap || (!cap.efforts.length && !t.effort);
      fields.set(key+':model',model);fields.set(key+':effort',effort);
    }
  }
  return {node,update};
}
