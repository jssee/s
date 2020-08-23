// import path from 'path';
import { mkdir, rm } from 'shelljs';
import { build } from 'esbuild';

const OUT_DIR = 'out';

export default async (cmd: string) => {
  if (cmd === 'clean') {
    rm('-rf', OUT_DIR);
  }

  if (cmd === 'build') {
    mkdir('-p', OUT_DIR);
    buildJS();
  }

  return console.log(cmd);
};

async function buildJS() {
  build({
    entryPoints: ['./foo.js'],
    outdir: 'out',
    minify: true,
    bundle: false,
  });
}
