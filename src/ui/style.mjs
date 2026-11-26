export const css = `
/* Keep every selector inside the mount; the host owns the rest of the page. */
.dshr-shell {
  --rt-bg:#f4f6f5; --rt-paper:#fff; --rt-soft:#f5f8f7; --rt-line:#d7e1dd; --rt-ink:#182d28; --rt-muted:#4e665d;
  --rt-accent:#14604d; --rt-hover:#0b493a; --rt-on-accent:#fff; --rt-focus:#137780; --rt-meter:#25826b;
  --rt-green-bg:#e3f4eb; --rt-green-fg:#185d3f; --rt-amber-bg:#fff2d7; --rt-amber-fg:#765015;
  --rt-blue-bg:#e6effb; --rt-blue-fg:#284f87; --rt-red-bg:#fbe9e7; --rt-red-fg:#8b3631;
  width:100%; height:100%; min-width:0; overflow:auto; container-type:inline-size; container-name:dshr-pane;
  background:var(--rt-bg);
}
.dshr {
  color-scheme:light; color:var(--rt-ink); text-align:start; font:normal 14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
}
@media (prefers-color-scheme:dark) {
  .dshr {color-scheme:dark}.dshr-shell {--rt-bg:#121b18; --rt-paper:#1b2823; --rt-soft:#203029; --rt-line:#3c5046; --rt-ink:#e8f0eb; --rt-muted:#aec4b7;
    --rt-accent:#9cdab8; --rt-hover:#b9edcc; --rt-on-accent:#122d20; --rt-focus:#86dcda; --rt-meter:#8bd5ac;
    --rt-green-bg:#203f2f; --rt-green-fg:#a8e1b9; --rt-amber-bg:#40331c; --rt-amber-fg:#efd296;
    --rt-blue-bg:#25354a; --rt-blue-fg:#b4cdef; --rt-red-bg:#442b29; --rt-red-fg:#ffbcb4;}
}
.dshr,.dshr *,.dshr *::before,.dshr *::after {box-sizing:border-box}
.dshr [hidden],.dshr-shell>.rt-wrap>[hidden],.dshr-shell .rt-workbench>[hidden] {display:none !important}
.dshr :is(input,select,textarea,button,summary):focus-visible {outline:3px solid var(--rt-focus);outline-offset:3px}
.dshr :is(h1,h2,h3,h4,h5,p,pre,dl,dd) {margin:0;overflow-wrap:anywhere}
.dshr h1,.dshr h2,.dshr h3,.dshr h4,.dshr h5 {color:var(--rt-ink);font-family:inherit;line-height:1.35;letter-spacing:-.01em}
.dshr h1 {font-size:clamp(23px,4cqw,32px);font-weight:720}.dshr h2 {font-size:21px;font-weight:700}.dshr h3 {font-size:17px;font-weight:680}.dshr h4 {font-size:15px;font-weight:650}.dshr h5 {font-size:14px;font-weight:680}
.dshr hr {width:100%;border:0;border-top:1px solid var(--rt-line);margin:18px 0}
.dshr-shell>.rt-wrap {box-sizing:border-box;max-width:1080px;min-width:0;margin:0 auto;padding:clamp(10px,1.5cqw,20px) clamp(12px,2.5cqw,30px)}
.dshr-shell>.rt-wrap:has(.rt-workbench[data-pane=open]) {max-width:1680px}
.dshr-shell .rt-workbench {display:grid;grid-template-columns:minmax(0,1fr);align-items:start;gap:16px}
.dshr-shell .rt-workbench[data-pane=open] {grid-template-columns:minmax(0,1fr) minmax(0,1.05fr)}
.dshr-shell .rt-board {min-width:0}
.dshr-shell .rt-session-side {box-sizing:border-box;display:flex;flex-direction:column;position:sticky;top:8px;height:clamp(280px,80dvh,920px);min-height:0;min-width:0;overflow:hidden;border:1px solid var(--rt-line);border-radius:12px;background:var(--rt-paper)}
.dshr-shell .rt-pane-chrome {display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid var(--rt-line)}
.dshr-shell .rt-pane-chrome>div {min-width:0}.dshr-shell .rt-pane-chrome h2,.dshr-shell .rt-pane-chrome .rt-muted {overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dshr-shell .rt-pane-chrome h2 {font-size:17px}.dshr-shell .rt-pane-chrome .rt-eyebrow {margin:0}.dshr-shell .rt-pane-chrome button {flex-shrink:0}
.dshr-shell .rt-pane-body,.dshr-shell .rt-pane-mount {display:flex;flex-direction:column;flex:1 1 0;width:100%;min-height:0;min-width:0;overflow:hidden}
.dshr-shell .rt-pane-mount {height:100%}
.dshr .rt-header,.dshr .rt-brand,.dshr .rt-tools,.dshr .rt-actions,.dshr .rt-nav,.dshr .rt-compose-foot,.dshr .rt-settings-foot,.dshr .rt-ledger-head,.dshr .rt-item-top {display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dshr .rt-header,.dshr .rt-compose-foot,.dshr .rt-settings-foot,.dshr .rt-ledger-head {justify-content:space-between}
.dshr .rt-header {display:grid;grid-template-columns:minmax(0,1fr) auto auto;grid-template-areas:'identity tabs tools';gap:8px 16px;padding-bottom:9px;margin:0 0 10px;border-bottom:1px solid var(--rt-line)}
.dshr .rt-header>.rt-tools {grid-area:tools}.dshr .rt-brand {grid-area:identity;gap:9px}.dshr .rt-mark {display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:var(--rt-accent);color:var(--rt-on-accent);font-size:29px;font-weight:600;line-height:1}
.dshr .rt-eyebrow {font-size:10.5px;line-height:1.5;font-weight:700;color:var(--rt-muted);letter-spacing:.11em;margin:0 0 6px}
.dshr .rt-brand h1 {font-size:clamp(20px,2.5cqw,25px)}.dshr .rt-brand .rt-eyebrow {margin-bottom:0;line-height:1.2}.dshr .rt-muted {font-size:12.5px;line-height:1.6;color:var(--rt-muted)}
.dshr .rt-connection,.dshr .rt-badge {display:inline-flex;align-items:center;gap:6px;border:1px solid var(--rt-line);border-radius:99px;padding:3px 9px;line-height:1.45;font-size:12px;font-weight:600;background:var(--rt-soft);color:var(--rt-muted)}
.dshr .rt-connection::before {content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.dshr .rt-connection[data-on=true] {background:var(--rt-green-bg);color:var(--rt-green-fg);border-color:transparent}
.dshr .rt-btn,.dshr .rt-nav-btn {appearance:none;display:inline-flex;align-items:center;justify-content:center;max-width:100%;border:1px solid var(--rt-line);border-radius:8px;padding:7px 12px;min-height:34px;background:var(--rt-paper);color:var(--rt-ink);font:600 13px/1.4 inherit;font-family:inherit;font-size:13px;font-weight:600;line-height:1.4;cursor:pointer;white-space:normal;overflow-wrap:anywhere}
.dshr .rt-btn:hover:not(:disabled),.dshr .rt-nav-btn:hover {border-color:var(--rt-accent);color:var(--rt-accent)}
.dshr .rt-btn.rt-primary,.dshr .rt-nav-btn[aria-pressed=true] {background:var(--rt-accent);border-color:var(--rt-accent);color:var(--rt-on-accent)}
.dshr .rt-btn.rt-primary:hover:not(:disabled) {background:var(--rt-hover);color:var(--rt-on-accent)}
.dshr .rt-btn.rt-quiet {background:transparent;color:var(--rt-accent);border-color:transparent}
.dshr .rt-btn:disabled,.dshr :is(input,textarea,select):disabled {opacity:.56;cursor:not-allowed}
.dshr .rt-nav {grid-area:tabs;gap:4px;margin:0}
.dshr .rt-nav-btn {background:transparent;border-color:transparent}.dshr .rt-nav-btn[aria-pressed=true] {background:var(--rt-ink);border-color:var(--rt-ink);color:var(--rt-paper)}
.dshr .rt-card {min-width:0;background:var(--rt-paper);border:1px solid var(--rt-line);border-radius:15px;padding:clamp(16px,2.2cqw,25px)}
.dshr .rt-settings-grid {display:grid;grid-template-columns:minmax(0,1.7fr) minmax(0,1fr);align-items:stretch;gap:15px}
.dshr .rt-compose {padding:11px 15px;border-top:2px solid var(--rt-meter)}
.dshr .rt-compose-head {display:flex;align-items:baseline;gap:2px 12px;flex-wrap:wrap;margin-bottom:6px}.dshr .rt-compose-head h2 {font-size:18px}
.dshr .rt-compose>.rt-field>.rt-label {position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.dshr .rt-compose textarea {min-height:50px;padding:6px 9px}.dshr .rt-compose .rt-compose-foot {margin-top:5px;gap:4px 10px}.dshr .rt-compose-foot>.rt-btn {margin-inline-start:auto}.dshr .rt-compose-foot>.rt-msg {flex:1 1 180px;margin:0;padding:4px 7px}
.dshr .rt-settings-grid h3+.rt-muted {margin:5px 0 14px}
.dshr .rt-field {display:flex;flex-direction:column;gap:5px;min-width:0;margin:0;color:var(--rt-ink)}
.dshr .rt-label,.dshr .rt-index,.dshr .rt-facts dt {font:600 12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--rt-muted);font-variant-numeric:tabular-nums}
.dshr input,.dshr select,.dshr textarea {display:block;min-width:0;width:100%;max-width:100%;margin:0;border:1px solid var(--rt-line);border-radius:7px;padding:8px 10px;font:inherit;line-height:1.5;color:var(--rt-ink);background:var(--rt-paper)}
.dshr select {text-overflow:ellipsis;padding-right:20px}.dshr textarea {resize:vertical;min-height:65px}.dshr textarea::placeholder,.dshr input::placeholder {color:var(--rt-muted);opacity:.82}
.dshr [aria-invalid=true] {border-color:var(--rt-red-fg)}.dshr .rt-compose-foot {margin-top:9px}

.dshr .rt-ledger {margin-top:14px}.dshr .rt-ledger-head {margin-bottom:7px}.dshr .rt-clean-rules {margin-top:4px}.dshr .rt-clean-rules summary {font-size:12px}.dshr .rt-ledger-head .rt-field {flex-flow:row wrap;align-items:center;gap:7px}.dshr .rt-ledger-head select {width:auto;max-width:100%}
.dshr .rt-items,.dshr .rt-projects {display:grid;gap:12px}
.dshr .rt-task-list {max-height:clamp(260px,66dvh,880px);overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;border:1px solid var(--rt-line);border-radius:12px;background:var(--rt-paper)}
.dshr .rt-task-list:focus-visible {outline:3px solid var(--rt-focus);outline-offset:2px}
/* Respond to the ledger's own width: it also shares the workbench with the side pane. */
.dshr .rt-task-list {container:rt-ledger / inline-size}
.dshr .rt-ledger-branch,.dshr .rt-ledger-heading,.dshr .rt-ledger-children {min-width:0}
.dshr .rt-ledger-project+.rt-ledger-project {border-block-start:1px solid var(--rt-line)}
.dshr .rt-ledger-row {display:flex;align-items:center;flex-wrap:wrap;gap:2px 6px;padding:3px 7px}
.dshr .rt-ledger-heading {flex:1 1 13rem}
.dshr .rt-ledger-toggle {display:flex;align-items:center;gap:10px;width:100%;min-width:0;min-height:42px;appearance:none;border:0;border-radius:6px;padding:7px 5px;background:transparent;color:var(--rt-ink);font:inherit;text-align:start;cursor:pointer}
.dshr .rt-ledger-toggle:hover {background:var(--rt-soft)}.dshr .rt-ledger-toggle:focus-visible {outline-offset:-2px}
.dshr .rt-ledger-caret {display:grid;place-items:center;flex:none;width:11px;color:var(--rt-accent)}
.dshr .rt-ledger-caret::after {content:"";width:7px;height:7px;border-right:2px solid;border-bottom:2px solid;transform:rotate(-45deg)}
.dshr .rt-ledger-toggle[aria-expanded=true]>.rt-ledger-caret::after {transform:rotate(45deg)}
.dshr .rt-ledger-copy {display:grid;flex:1 1 0;min-width:0;gap:2px}
.dshr .rt-ledger-title {display:flex;align-items:baseline;gap:7px;min-width:0}
.dshr .rt-ledger-kind {flex:none;font-size:11px;font-weight:600;line-height:1.4;color:var(--rt-accent)}
.dshr .rt-ledger-name,.dshr .rt-ledger-detail,.dshr .rt-ledger-count {min-width:0;overflow-wrap:anywhere;unicode-bidi:isolate}
.dshr .rt-ledger-name {font-weight:680}.dshr .rt-ledger-detail {color:var(--rt-muted);font-size:12px;font-weight:400;line-height:1.4}
.dshr .rt-ledger-meta {display:flex;flex:0 1 auto;max-width:45%;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:3px 6px}
.dshr .rt-ledger-count,.dshr .rt-ledger-state {font-size:12px;line-height:1.45;font-weight:500;font-variant-numeric:tabular-nums;color:var(--rt-muted)}
.dshr .rt-ledger-state {padding:1px 7px;border-radius:99px;white-space:nowrap}
.dshr .rt-ledger-project>.rt-ledger-children {margin:0 8px 9px clamp(14px,3cqw,28px);padding-inline-start:7px;border-inline-start:2px solid var(--rt-line)}
.dshr .rt-ledger-session+.rt-ledger-session {margin-top:4px}
.dshr .rt-ledger-session>.rt-ledger-row {border-inline-start:3px solid transparent;border-radius:6px;background:var(--rt-soft)}
.dshr .rt-ledger-session[data-selected=true]>.rt-ledger-row {border-inline-start-color:var(--rt-meter)}
.dshr .rt-ledger-session .rt-ledger-toggle:hover {background:var(--rt-paper)}
.dshr .rt-ledger-open {flex:none;margin-inline-start:auto;font-size:12px;padding:5px 9px}
.dshr .rt-ledger-session>.rt-ledger-children {margin:3px 0 7px clamp(8px,2cqw,18px);padding-inline-start:4px;border-inline-start:1px solid var(--rt-line)}
.dshr .rt-ledger-empty {padding:7px 9px}
@container rt-ledger (max-width:560px) {
  .dshr .rt-ledger-row {padding:2px 4px}.dshr .rt-ledger-toggle {display:grid;grid-template-columns:11px minmax(0,1fr);gap:3px 6px}
  .dshr .rt-ledger-meta {grid-column:2;max-width:none;justify-content:flex-start}
  .dshr .rt-ledger-project>.rt-ledger-children {margin-inline:11px 3px;padding-inline-start:4px}.dshr .rt-ledger-session>.rt-ledger-children {margin-inline-start:7px;padding-inline-start:2px}
  .dshr .rt-ledger-session .rt-record-meta {flex-wrap:wrap;gap:2px 5px}
}
.dshr .rt-task {min-width:0;border-bottom:1px solid var(--rt-line)}.dshr .rt-task:last-child {border-bottom:0}
.dshr .rt-record-row {display:flex;align-items:center;gap:4px;padding:2px 5px;border-inline-start:3px solid transparent}
.dshr .rt-record-row:hover,.dshr .rt-task[data-selected=true]>.rt-record-row {background:var(--rt-soft)}
.dshr .rt-task[data-selected=true]>.rt-record-row {border-inline-start-color:var(--rt-meter)}
.dshr .rt-record-select {flex:1 1 0;display:grid;gap:3px;min-width:0;padding:6px 8px;border:0;border-radius:5px;background:transparent;color:var(--rt-ink);font:inherit;text-align:start;cursor:pointer}
.dshr .rt-record-title,.dshr .rt-record-info {min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dshr .rt-record-title {font-weight:650}
.dshr .rt-record-meta {min-width:0;display:flex;align-items:center;gap:8px;color:var(--rt-muted);font-size:12px;line-height:1.4}
.dshr .rt-record-meta :is(.rt-badge,time) {flex:none;font-variant-numeric:tabular-nums;white-space:nowrap}.dshr .rt-record-meta .rt-badge {padding:1px 7px}
.dshr .rt-record-toggle {flex:0 0 auto;font-size:12px;padding:6px 8px}.dshr .rt-record-details {padding:10px 14px 13px;border-top:1px dashed var(--rt-line)}
.dshr .rt-full-text {max-height:16rem;overflow:auto;margin:4px 0 10px}.dshr .rt-record-admin {border-top:1px solid var(--rt-line);display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px;padding-top:10px}
.dshr .rt-danger {color:var(--rt-red-fg)}.dshr .rt-clean-confirm {width:100%;padding:10px;border:1px solid var(--rt-line);border-radius:8px;background:var(--rt-soft);margin-bottom:8px}.dshr .rt-clean-confirm .rt-instruction {margin:0 0 8px}.dshr .rt-clean-confirm ul {max-height:9rem;overflow:auto;margin:4px 0;padding-inline-start:20px;overflow-wrap:anywhere}
.dshr .rt-user-text,.dshr .rt-msg,.dshr .rt-reason {white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal}
.dshr .rt-items {margin-top:8px}.dshr .rt-item {min-width:0;border:1px solid var(--rt-line);border-radius:10px;padding:clamp(12px,1.7cqw,19px)}
.dshr .rt-item-top {gap:9px;margin-bottom:7px}.dshr .rt-badge {border:0;padding:3px 9px}.dshr [data-tone=blue] {color:var(--rt-blue-fg);background:var(--rt-blue-bg)}.dshr [data-tone=amber] {color:var(--rt-amber-fg);background:var(--rt-amber-bg)}
.dshr [data-tone=red] {color:var(--rt-red-fg);background:var(--rt-red-bg)}.dshr [data-tone=green] {color:var(--rt-green-fg);background:var(--rt-green-bg)}
.dshr .rt-facts {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr));gap:7px 15px;margin:12px 0 7px;padding:9px 12px;background:var(--rt-soft);border-radius:7px}
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
@container dshr-pane (max-width:900px) {
  .dshr-shell .rt-workbench[data-pane=open] {grid-template-columns:minmax(0,1fr)}
  .dshr-shell .rt-workbench[data-pane=open]>.rt-session-side {grid-column:1;grid-row:1;position:static;height:clamp(250px,64dvh,740px)}
}
@container dshr-pane (max-width:780px) {
  .dshr .rt-settings-grid {grid-template-columns:minmax(0,1fr)}
}
@container dshr-pane (max-width:650px) {
  .dshr .rt-header {grid-template-columns:minmax(0,1fr) auto;grid-template-areas:'identity tools' 'tabs tabs';row-gap:6px}.dshr .rt-nav {justify-content:flex-start}
}
@container dshr-pane (max-width:480px) {
  .dshr-shell>.rt-wrap {padding:12px}.dshr .rt-header {column-gap:6px}.dshr .rt-card {padding:12px}.dshr .rt-brand .rt-mark {display:none}
  .dshr .rt-facts {grid-template-columns:minmax(0,1fr) minmax(0,.7fr)}.dshr .rt-facts>div:last-child {grid-column:1/-1}
  .dshr .rt-record-select {padding:6px 3px}.dshr .rt-record-meta {gap:5px}.dshr .rt-record-details {padding:9px}.dshr .rt-choice-row>.rt-field {flex-basis:100%}
  .dshr .rt-model-grid {grid-template-columns:minmax(0,1fr)}.dshr .rt-settings-foot {align-items:end}.dshr .rt-btn,.dshr .rt-nav-btn {min-height:38px}
}
`;
