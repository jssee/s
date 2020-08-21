import { build } from 'esbuild';

export default (cmd: string) => {
  buildJS();
  return console.log(cmd);
};

async function buildJS() {
  build({ entryPoints: ['./**/*.js'] });
}
