// Empaqueta el código del renderer (src/js) en dist/ con esbuild.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/js/main.js'],
  bundle: true,
  format: 'esm',
  splitting: true,
  outdir: 'dist',
  target: 'chrome130',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
  legalComments: 'none',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
