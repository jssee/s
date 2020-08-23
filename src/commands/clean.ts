import { rm } from 'shelljs';

export default (opts: any) => rm('-rf', opts.outdir);
