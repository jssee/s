import path from 'path';
import { promises as fs } from 'fs';

import reshape from 'reshape';
import { mkdir } from 'shelljs';
import clean from './clean';

export default async (opts: any = {}) => {
  clean(opts.outdir);
  prepareOutDir(opts.outdir);

  let pages: string[] = await fs.readdir(path.join(process.cwd(), 'pages'));
  await Promise.all(
    pages.map(async filename => {
      let page = path.join(path.resolve(), 'pages', filename);
      let body = await reshapify(page);
      await fs.writeFile(
        path.join(process.cwd(), opts.outdir, filename),
        body as string,
        'utf8'
      );

      console.log(filename);
    })
  );

  console.log('html done');
  return opts;
};

async function reshapify(path: string) {
  let html = await fs.readFile(path);
  return new Promise(async (resolve, _) => {
    reshape({})
      .process(html)
      .then((res: any) => {
        resolve(res.output());
      });
  });
}

function prepareOutDir(opts) {
  mkdir('-p', opts.outdir);
}
