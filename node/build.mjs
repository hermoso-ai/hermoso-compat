// CommonJS copies for `require()` callers (Ayrshare's package ships both). The ESM in src/ is the source.
import { build } from 'esbuild';
for (const name of ['index', 'ayrshare', 'zernio', 'postiz']) {
  await build({ entryPoints: [`src/${name}.js`], outfile: `dist/${name}.cjs`, bundle: true, format: 'cjs', platform: 'node', target: 'node18', footer: { js: "if (module.exports.default) { const d = module.exports.default; for (const k of Object.keys(module.exports)) { if (k !== 'default' && !(k in d)) try { d[k] = module.exports[k]; } catch (e) {} } d.default = d; module.exports = d; }" } });
}
