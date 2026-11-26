export const css = `
/* Keep every selector inside the mount; the host owns the rest of the page. */
.dshr {
  --rt-bg:#f4f6f5; --rt-paper:#fff; --rt-soft:#f5f8f7; --rt-line:#d7e1dd; --rt-ink:#182d28; --rt-muted:#4e665d;
  --rt-accent:#14604d; --rt-hover:#0b493a; --rt-on-accent:#fff; --rt-focus:#137780; --rt-meter:#25826b;
  --rt-green-bg:#e3f4eb; --rt-green-fg:#185d3f; --rt-amber-bg:#fff2d7; --rt-amber-fg:#765015;
  --rt-blue-bg:#e6effb; --rt-blue-fg:#284f87; --rt-red-bg:#fbe9e7; --rt-red-fg:#8b3631;
  width:100%; height:100%; min-width:0; overflow:auto; container-type:inline-size; container-name:dshr-pane;
  color-scheme:light; background:var(--rt-bg); color:var(--rt-ink); text-align:start; font:normal 14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
}
@media (prefers-color-scheme:dark) {
  .dshr {color-scheme:dark; --rt-bg:#121b18; --rt-paper:#1b2823; --rt-soft:#203029; --rt-line:#3c5046; --rt-ink:#e8f0eb; --rt-muted:#aec4b7;
    --rt-accent:#9cdab8; --rt-hover:#b9edcc; --rt-on-accent:#122d20; --rt-focus:#86dcda; --rt-meter:#8bd5ac;
    --rt-green-bg:#203f2f; --rt-green-fg:#a8e1b9; --rt-amber-bg:#40331c; --rt-amber-fg:#efd296;
    --rt-blue-bg:#25354a; --rt-blue-fg:#b4cdef; --rt-red-bg:#442b29; --rt-red-fg:#ffbcb4;}
}
.dshr,.dshr *,.dshr *::before,.dshr *::after {box-sizing:border-box}
.dshr [hidden] {display:none !important}
.dshr :is(input,select,textarea,button,summary):focus-visible {outline:3px solid var(--rt-focus);outline-offset:3px}
.dshr :is(h1,h2,h3,h4,h5,p,pre,dl,dd) {margin:0;overflow-wrap:anywhere}
.dshr h1,.dshr h2,.dshr h3,.dshr h4,.dshr h5 {color:var(--rt-ink);font-family:inherit;line-height:1.35;letter-spacing:-.01em}
.dshr h1 {font-size:clamp(23px,4cqw,32px);font-weight:720}.dshr h2 {font-size:21px;font-weight:700}.dshr h3 {font-size:17px;font-weight:680}.dshr h4 {font-size:15px;font-weight:650}.dshr h5 {font-size:14px;font-weight:680}
.dshr hr {width:100%;border:0;border-top:1px solid var(--rt-line);margin:18px 0}
.dshr .rt-wrap {max-width:1160px;min-width:0;margin:0 auto;padding:clamp(14px,3.4cqw,38px)}
.dshr .rt-header,.dshr .rt-brand,.dshr .rt-tools,.dshr .rt-actions,.dshr .rt-nav,.dshr .rt-compose-foot,.dshr .rt-settings-foot,.dshr .rt-ledger-head,.dshr .rt-item-top {display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshr .rt-header,.dshr .rt-compose-foot,.dshr .rt-settings-foot,.dshr .rt-ledger-head {justify-content:space-between}
.dshr .rt-brand {gap:13px}.dshr .rt-mark {display:grid;place-items:center;width:44px;height:44px;border-radius:13px;background:var(--rt-accent);color:var(--rt-on-accent);font-size:29px;font-weight:600;line-height:1}
.dshr .rt-eyebrow {font-size:10.5px;line-height:1.5;font-weight:700;color:var(--rt-muted);letter-spacing:.11em;margin:0 0 6px}
.dshr .rt-brand .rt-eyebrow {margin-bottom:2px}.dshr .rt-muted {font-size:12.5px;line-height:1.6;color:var(--rt-muted)}
.dshr .rt-connection,.dshr .rt-badge {display:inline-flex;align-items:center;gap:6px;border:1px solid var(--rt-line);border-radius:99px;padding:3px 9px;line-height:1.45;font-size:12px;font-weight:600;background:var(--rt-soft);color:var(--rt-muted)}
.dshr .rt-connection::before {content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.dshr .rt-connection[data-on=true] {background:var(--rt-green-bg);color:var(--rt-green-fg);border-color:transparent}
.dshr .rt-btn,.dshr .rt-nav-btn {appearance:none;display:inline-flex;align-items:center;justify-content:center;max-width:100%;border:1px solid var(--rt-line);border-radius:8px;padding:7px 12px;min-height:34px;background:var(--rt-paper);color:var(--rt-ink);font:600 13px/1.4 inherit;font-family:inherit;font-size:13px;font-weight:600;line-height:1.4;cursor:pointer;white-space:normal;overflow-wrap:anywhere}
.dshr .rt-btn:hover:not(:disabled),.dshr .rt-nav-btn:hover {border-color:var(--rt-accent);color:var(--rt-accent)}
.dshr .rt-btn.rt-primary,.dshr .rt-nav-btn[aria-pressed=true] {background:var(--rt-accent);border-color:var(--rt-accent);color:var(--rt-on-accent)}
.dshr .rt-btn.rt-primary:hover:not(:disabled) {background:var(--rt-hover);color:var(--rt-on-accent)}
.dshr .rt-btn.rt-quiet {background:transparent;color:var(--rt-accent);border-color:transparent}
.dshr .rt-btn:disabled,.dshr :is(input,textarea,select):disabled {opacity:.56;cursor:not-allowed}
.dshr .rt-nav {gap:5px;margin:18px 0 20px;padding-bottom:13px;border-bottom:1px solid var(--rt-line)}
.dshr .rt-nav-btn {background:transparent;border-color:transparent}.dshr .rt-nav-btn[aria-pressed=true] {background:var(--rt-ink);border-color:var(--rt-ink);color:var(--rt-paper)}
.dshr .rt-card {min-width:0;background:var(--rt-paper);border:1px solid var(--rt-line);border-radius:15px;padding:clamp(16px,2.2cqw,25px)}
.dshr .rt-intro-grid,.dshr .rt-settings-grid {display:grid;grid-template-columns:minmax(0,1.7fr) minmax(0,1fr);align-items:stretch;gap:15px}
.dshr .rt-compose {border-top:3px solid var(--rt-meter)}.dshr .rt-compose>h2+.rt-muted,.dshr .rt-settings-grid h3+.rt-muted {margin:5px 0 14px}
.dshr .rt-field {display:flex;flex-direction:column;gap:5px;min-width:0;margin:0;color:var(--rt-ink)}
.dshr .rt-label,.dshr .rt-index,.dshr .rt-facts dt {font:600 12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--rt-muted);font-variant-numeric:tabular-nums}
.dshr input,.dshr select,.dshr textarea {display:block;min-width:0;width:100%;max-width:100%;margin:0;border:1px solid var(--rt-line);border-radius:7px;padding:8px 10px;font:inherit;line-height:1.5;color:var(--rt-ink);background:var(--rt-paper)}
.dshr select {text-overflow:ellipsis;padding-right:20px}.dshr textarea {resize:vertical;min-height:65px}.dshr textarea::placeholder,.dshr input::placeholder {color:var(--rt-muted);opacity:.82}
.dshr [aria-invalid=true] {border-color:var(--rt-red-fg)}.dshr .rt-compose-foot {margin-top:9px}
.dshr .rt-overview {background:#183e34;color:#f2fbf6;--rt-ink:#f2fbf6;--rt-muted:#bad4c8;--rt-line:#406354;--rt-meter:#99dcb1}
.dshr .rt-stats {display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin:18px 0 19px}.dshr .rt-stats>div {min-width:0;display:flex;flex-direction:column}
.dshr .rt-stats strong {font-size:clamp(20px,3cqw,30px);line-height:1.15;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.dshr .rt-stats .rt-muted {margin-top:4px}
.dshr progress {appearance:none;display:block;width:100%;height:6px;border:0;border-radius:99px;overflow:hidden;background:var(--rt-line);color:var(--rt-meter);margin:6px 0 0}
.dshr progress::-webkit-progress-bar {background:var(--rt-line)}.dshr progress::-webkit-progress-value {background:var(--rt-meter);border-radius:99px}.dshr progress::-moz-progress-bar {background:var(--rt-meter)}
.dshr .rt-ledger {margin-top:26px}.dshr .rt-ledger-head {margin-bottom:13px}.dshr .rt-ledger-head .rt-field {flex-flow:row wrap;align-items:center;gap:7px}.dshr .rt-ledger-head select {width:auto;max-width:100%}
.dshr .rt-task-list,.dshr .rt-items,.dshr .rt-projects {display:grid;gap:12px}.dshr .rt-task-head {display:flex;gap:15px;align-items:start;justify-content:space-between;min-width:0}.dshr .rt-task-head>div:first-child {min-width:0;flex:1}
.dshr .rt-progress-box {min-width:105px;flex:0 0 auto;max-width:100%}.dshr .rt-user-text,.dshr .rt-msg,.dshr .rt-reason {white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal}
.dshr .rt-items,.dshr .rt-task-head+.rt-muted {margin-top:15px}.dshr .rt-item {min-width:0;border:1px solid var(--rt-line);border-radius:10px;padding:clamp(12px,1.7cqw,19px)}
.dshr .rt-item-top {gap:9px;margin-bottom:7px}.dshr .rt-badge {border:0;padding:3px 9px}.dshr [data-tone=blue] {color:var(--rt-blue-fg);background:var(--rt-blue-bg)}.dshr [data-tone=amber] {color:var(--rt-amber-fg);background:var(--rt-amber-bg)}
.dshr [data-tone=red] {color:var(--rt-red-fg);background:var(--rt-red-bg)}.dshr [data-tone=green] {color:var(--rt-green-fg);background:var(--rt-green-bg)}
.dshr .rt-facts {display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,.6fr) minmax(0,1fr);gap:7px 15px;margin:12px 0 7px;padding:9px 12px;background:var(--rt-soft);border-radius:7px}
.dshr .rt-facts>div,.dshr .rt-choice-row>*,.dshr .rt-model-grid>* {min-width:0}.dshr .rt-facts dd {font-size:13px;line-height:1.45;overflow-wrap:anywhere;margin-top:2px}
.dshr .rt-reason {font-size:13px;color:var(--rt-muted)}.dshr .rt-instruction,.dshr .rt-setup-warning {background:var(--rt-amber-bg);color:var(--rt-amber-fg);border-radius:7px;padding:9px 12px;margin-top:10px;font-size:13px}
.dshr .rt-setup-warning {display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.dshr .rt-setup-warning .rt-quiet {color:inherit}
.dshr .rt-action-box {border:1px solid var(--rt-line);border-radius:8px;padding:12px;margin-top:12px;background:var(--rt-soft)}
.dshr .rt-action-box>p,.dshr .rt-follow>p {margin:4px 0 8px}.dshr .rt-choice-row {display:flex;align-items:end;gap:8px;flex-wrap:wrap;margin-top:10px}.dshr .rt-choice-row>.rt-field {flex:1 1 220px}
.dshr .rt-item .rt-actions {margin-top:9px}.dshr details>summary {width:fit-content;max-width:100%;cursor:pointer;font-size:13px;font-weight:650;color:var(--rt-accent);padding:6px 0}
.dshr .rt-follow,.dshr .rt-result {margin-top:8px}.dshr .rt-follow[open] {border-top:1px solid var(--rt-line);padding-top:5px}.dshr .rt-follow .rt-btn {margin-top:8px}
.dshr pre {max-height:22rem;overflow:auto;background:var(--rt-soft);border-radius:7px;padding:10px;font:13px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}
.dshr .rt-msg {margin:8px 0;border-radius:8px;padding:9px 12px;font-size:13px}.dshr .rt-msg[data-tone=info] {color:var(--rt-blue-fg);background:var(--rt-blue-bg)}
.dshr .rt-empty {border-style:dashed;text-align:center;padding:24px 12px}.dshr .rt-empty>p,.dshr .rt-orphan>p {margin-top:6px}.dshr .rt-orphan {margin-top:14px}
.dshr .rt-section-head {margin-bottom:14px}.dshr .rt-section-head>p {margin-top:4px}.dshr .rt-settings-grid {grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}
.dshr .rt-settings-grid .rt-field+.rt-field,.dshr .rt-settings-grid h4+.rt-muted,.dshr .rt-projects,.dshr .rt-projects+.rt-muted,.dshr .rt-projects~.rt-btn {margin-top:9px}
.dshr .rt-project-row,.dshr .rt-tier {background:var(--rt-soft);padding:12px;border:1px solid var(--rt-line);border-radius:9px;min-width:0}
.dshr .rt-project-row {display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px}.dshr .rt-project-row>.rt-field:nth-child(2) {grid-row:2;grid-column:1/-1;margin:0}.dshr .rt-project-row>.rt-btn {grid-row:1;grid-column:2;align-self:end}
.dshr .rt-tier {margin:14px 0 0}.dshr .rt-tier legend {font-size:14px;font-weight:700;padding:0 5px;color:var(--rt-ink)}.dshr .rt-tier>p {margin-bottom:6px}
.dshr .rt-model-grid {display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:8px}.dshr .rt-model-grid .rt-field+.rt-field {margin:0}
.dshr .rt-runtime {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:6px 14px;margin:7px 0 10px;padding-inline:12px}.dshr .rt-runtime>div {min-width:0}.dshr .rt-runtime dd {font-size:13px;overflow-wrap:anywhere}
.dshr .rt-model-editor .rt-action-box>h4 {margin:12px 0 6px}.dshr .rt-preview-models {display:grid;gap:0;margin:0 0 10px}
.dshr .rt-preview-models>div {display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:baseline;border-bottom:1px solid var(--rt-line);padding:6px 0}.dshr .rt-preview-models dd {font-size:13px;overflow-wrap:anywhere}
.dshr .rt-creation-mode {border-top:1px solid var(--rt-line);margin-top:18px;padding-top:15px}.dshr .rt-creation-mode>p {margin:5px 0}
.dshr .rt-settings-foot {padding:13px 0}.dshr .rt-settings-foot>.rt-muted {flex:1 1 210px}
@container dshr-pane (max-width:780px) {
  .dshr .rt-intro-grid,.dshr .rt-settings-grid {grid-template-columns:minmax(0,1fr)}.dshr .rt-overview {padding:16px}.dshr .rt-stats {margin:10px 0}
}
@container dshr-pane (max-width:480px) {
  .dshr .rt-wrap {padding:12px}.dshr .rt-header {gap:12px}.dshr .rt-nav {margin:13px 0}.dshr .rt-card {padding:14px}
  .dshr .rt-facts {grid-template-columns:minmax(0,1fr) minmax(0,.7fr)}.dshr .rt-facts>div:last-child {grid-column:1/-1}
  .dshr .rt-task-head {flex-direction:column;gap:6px}.dshr .rt-progress-box {width:100%}.dshr .rt-choice-row>.rt-field {flex-basis:100%}
  .dshr .rt-model-grid {grid-template-columns:minmax(0,1fr)}.dshr .rt-settings-foot {align-items:end}.dshr .rt-btn,.dshr .rt-nav-btn {min-height:38px}
}
`;
