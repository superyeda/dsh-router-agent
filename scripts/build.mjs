import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const {name}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
await mkdir(new URL('../lib/',import.meta.url),{recursive:true});
await build({absWorkingDir:root,entryPoints:['src/client.mjs'],outfile:'lib/client.js',bundle:true,platform:'browser',target:'es2022',format:'cjs',external:['react'],minify:true,legalComments:'none',charset:'utf8',
  banner:{js:'window.__ModuleLoader__.load({id:'+JSON.stringify(name)+',factory:function(require){var module={exports:{}},exports=module.exports;'},
  footer:{js:'return module.exports;}});'}});
const demo=await build({absWorkingDir:root,entryPoints:['examples/demo.mjs'],bundle:true,format:'iife',platform:'browser',target:'es2022',minify:true,legalComments:'none',charset:'utf8',write:false});
const template=await readFile(new URL('../examples/template.html',import.meta.url),'utf8');
await writeFile(new URL('../examples/try-router.html',import.meta.url),template.replace('/*APP*/',()=>demo.outputFiles[0].text.replace(/<\/script/gi,'<\\/script')));
console.log('Built DSH client and self-contained offline walkthrough.');
