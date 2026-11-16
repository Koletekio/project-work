import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fromBuild = path => new URL(path, import.meta.url);
const result = await build({
  entryPoints: [fileURLToPath(fromBuild('../frontend/effects.jsx'))],
  bundle: true, write: false, jsx: 'automatic', format: 'iife',
  minify: true, legalComments: 'inline', outdir: 'dist',
  nodePaths: [fileURLToPath(fromBuild('./node_modules'))],
  define: { 'process.env.NODE_ENV': '"production"' },
});
const css = result.outputFiles.find(file => file.path.endsWith('.css')).text;
const js = result.outputFiles.find(file => file.path.endsWith('.js')).text;
const source = readFileSync(fromBuild('../frontend/template.html'), 'utf8');
const html = source.replace('/* __REACT_BITS_CSS__ */', () => css)
  .replace('    /* __MOUNTAIN_CSS__ */', () => readFileSync(fromBuild('../frontend/mountains.css'), 'utf8').trimEnd())
  .replace('  <!-- __MOUNTAIN_HORIZON__ -->', () => readFileSync(fromBuild('../frontend/mountains.html'), 'utf8').trimEnd())
  .replace('/* __REACT_BITS_JS__ */', () => js.replace(/<\/script/gi, '<\\/script'));
writeFileSync(fromBuild('../server/index.html'), html);
console.log(`Inline build: ${Buffer.byteLength(js)} bytes JavaScript, ${Buffer.byteLength(css)} bytes CSS`);
