import fs from 'fs';
import path from 'path';
import mime from 'mime-types';
import glob from 'glob';
import { mkdir, rm } from 'shelljs';
import findUp from 'find-up';
import stripComments from 'strip-comments';
import {
  init as initESModuleLexer,
  ImportSpecifier,
  parse,
} from 'es-module-lexer';
import validatePackageName from 'validate-npm-package-name';

const cwd = process.cwd();
let installResults: [string, InstallResultCode][] = [];

function isImportOfPackage(importUrl: string, packageName: string) {
  return packageName === importUrl || importUrl.startsWith(packageName + '/');
}

function getWebDepName(dep: string): string {
  return validatePackageName(dep).validForNewPackages
    ? dep.replace(/\.js$/i, 'js') // if this is a top-level package ending in .js, replace with js (e.g. tippy.js -> tippyjs)
    : dep.replace(/\.m?js$/i, ''); // otherwise simply strip the extension (esbuild? will resolve it)
}

function resolveWebDependency(dep: string): DependencyLoc {
  // if dep points directly to a file within a package, return that reference.
  // No other lookup required.
  if (path.extname(dep) && !validatePackageName(dep).validForNewPackages) {
    const isJSFile = ['.js', '.mjs', '.cjs'].includes(path.extname(dep));
    return {
      type: isJSFile ? 'JS' : 'ASSET',
      loc: require.resolve(dep, { paths: [cwd] }),
    };
  }
  // If dep is a path within a package (but without an extension), we first need
  // to check for an export map in the package.json. If one exists, resolve to it.
  const [packageName, packageEntrypoint] = parsePackageImportSpecifier(dep);
  if (packageEntrypoint) {
    const [packageManifestLoc, packageManifest] = resolveDependencyManifest(
      packageName,
      cwd
    );
    if (packageManifestLoc && packageManifest && packageManifest.exports) {
      const exportMapEntry = packageManifest.exports['./' + packageEntrypoint];
      const exportMapValue =
        exportMapEntry?.browser ||
        exportMapEntry?.import ||
        exportMapEntry?.default ||
        exportMapEntry?.require ||
        exportMapEntry;
      if (typeof exportMapValue !== 'string') {
        console.error(
          `Package "${packageName}" exists but package.json "exports" does not include entry for "./${packageEntrypoint}".`
        );
        process.exit(1);
      }
      return {
        type: 'JS',
        loc: path.join(packageManifestLoc, '..', exportMapValue),
      };
    }
  }

  // Otherwise, resolve directly to the dep specifier. Note that this supports both
  // "package-name" & "package-name/some/path" where "package-name/some/path/package.json"
  // exists at that lower path, that must be used to resolve. In that case, export
  // maps should not be supported.
  const [depManifestLoc, depManifest] = resolveDependencyManifest(dep, cwd);
  if (!depManifest) {
    try {
      const maybeLoc = require.resolve(dep, { paths: [cwd] });
      return {
        type: 'JS',
        loc: maybeLoc,
      };
    } catch (err) {
      // Oh well, was worth a try
    }
  }
  if (!depManifestLoc || !depManifest) {
    throw new Error(
      `Package "${dep}" not found. Have you installed it? ${
        depManifestLoc ? depManifestLoc : ''
      }`
    );
  }
  if (
    depManifest.name &&
    (depManifest.name.startsWith('@reactesm') ||
      depManifest.name.startsWith('@pika/react'))
  ) {
    console.error(
      `React workaround packages no longer needed! Revert back to the official React & React-DOM packages.`
    );
    process.exit(1);
  }
  let foundEntrypoint: string =
    depManifest['browser:module'] ||
    depManifest.module ||
    depManifest['main:esnext'] ||
    depManifest.browser;
  // Some packages define "browser" as an object. We'll do our best to find the
  // right entrypoint in an entrypoint object, or fail otherwise.
  // See: https://github.com/defunctzombie/package-browser-field-spec
  if (typeof foundEntrypoint === 'object') {
    foundEntrypoint =
      foundEntrypoint[dep] ||
      foundEntrypoint['./index.js'] ||
      foundEntrypoint['./index'] ||
      foundEntrypoint['./'] ||
      foundEntrypoint['.'];
  }
  // If browser object is set but no relevant entrypoint is found, fall back to "main".
  if (!foundEntrypoint) {
    foundEntrypoint = depManifest.main;
  }
  // Sometimes packages don't give an entrypoint, assuming you'll fall back to "index.js".
  const isImplicitEntrypoint = !foundEntrypoint;
  if (isImplicitEntrypoint) {
    foundEntrypoint = 'index.js';
  }
  if (typeof foundEntrypoint !== 'string') {
    throw new Error(
      `"${dep}" has unexpected entrypoint: ${JSON.stringify(foundEntrypoint)}.`
    );
  }
  try {
    return {
      type: 'JS',
      loc: require.resolve(
        path.join(depManifestLoc || '', '..', foundEntrypoint)
      ),
    };
  } catch (err) {
    // Type only packages! Some packages are purely for TypeScript (ex: csstypes).
    // If no JS entrypoint was given or found, but a TS "types"/"typings" entrypoint
    // was given, assume a TS-types only package and ignore.
    if (isImplicitEntrypoint && (depManifest.types || depManifest.typings)) {
      return { type: 'IGNORE', loc: '' };
    }
    // Otherwise, file truly doesn't exist.
    throw err;
  }
}

const EMPTY_INSTALL_RETURN: InstallResult = {
  success: false,
  importMap: null,
};

export async function install(
  installTargets: InstallTarget[],
  { lockfile, config }: InstallOptions
): Promise<InstallResult> {
  const {
    webDependencies,
    alias: installAlias,
    installOptions: {
      installTypes,
      dest: destLoc,
      externalPackage: externalPackages,
      sourceMap,
      env,
      rollup: userDefinedRollup,
      treeshake: isTreeshake,
      polyfillNode,
    },
  } = config;

  const nodeModulesInstalled = findUp.sync('node_modules', {
    cwd,
    type: 'directory',
  });
  if (
    !webDependencies &&
    !(process.versions as any).pnp &&
    !nodeModulesInstalled
  ) {
    console.error(
      'No "node_modules" directory exists. Did you run "npm install" first?'
    );
    return EMPTY_INSTALL_RETURN;
  }
  const allInstallSpecifiers = new Set(
    installTargets
      .filter(
        dep =>
          !externalPackages.some((packageName: any) =>
            isImportOfPackage(dep.specifier, packageName)
          )
      )
      .map(dep => dep.specifier)
      .map(specifier => {
        const aliasEntry = findMatchingAliasEntry(config, specifier);
        return aliasEntry && aliasEntry.type === 'package'
          ? aliasEntry.to
          : specifier;
      })
      .sort()
  );
  const installEntrypoints: { [targetName: string]: string } = {};
  const assetEntrypoints: { [targetName: string]: string } = {};
  const importMap: ImportMap = { imports: {} };
  const installTargetsMap: { [targetLoc: string]: InstallTarget[] } = {};
  const skipFailures = false;

  for (const installSpecifier of allInstallSpecifiers) {
    const targetName = getWebDepName(installSpecifier);
    const proxiedName = sanitizePackageName(targetName); // sometimes we need to sanitize webModule names, as in the case of tippy.js -> tippyjs
    if (lockfile && lockfile.imports[installSpecifier]) {
      installEntrypoints[targetName] = lockfile.imports[installSpecifier];
      importMap.imports[installSpecifier] = `./${proxiedName}.js`;
      installResults.push([targetName, 'SUCCESS']);
      continue;
    }
    try {
      const { type: targetType, loc: targetLoc } = resolveWebDependency(
        installSpecifier
      );
      if (targetType === 'JS') {
        installEntrypoints[targetName] = targetLoc;
        importMap.imports[installSpecifier] = `./${proxiedName}.js`;
        Object.entries(installAlias)
          .filter(([, value]) => value === installSpecifier)
          .forEach(([key]) => {
            importMap.imports[key] = `./${targetName}.js`;
          });
        installTargetsMap[targetLoc] = installTargets.filter(
          t => installSpecifier === t.specifier
        );
        installResults.push([installSpecifier, 'SUCCESS']);
      } else if (targetType === 'ASSET') {
        assetEntrypoints[targetName] = targetLoc;
        importMap.imports[installSpecifier] = `./${proxiedName}`;
        installResults.push([installSpecifier, 'ASSET']);
      }
    } catch (err) {
      installResults.push([installSpecifier, 'FAIL']);
      if (skipFailures) {
        continue;
      }
      console.error(err.message || err);
      throw new Error(err);
    }
  }
  if (
    Object.keys(installEntrypoints).length === 0 &&
    Object.keys(assetEntrypoints).length === 0
  ) {
    console.error(`No ESM dependencies found!`);
    return EMPTY_INSTALL_RETURN;
  }

  await initESModuleLexer;
  let isCircularImportFound = false;
  let isFatalWarningFound = false;
  const inputOptions: InputOptions = {
    input: installEntrypoints,
    external: id =>
      externalPackages.some((packageName: any) =>
        isImportOfPackage(id, packageName)
      ),
    treeshake: { moduleSideEffects: 'no-external' },
    plugins: [
      !!webDependencies && rollupPluginCatchFetch(),
      rollupPluginNodeResolve({
        mainFields: ['browser:module', 'module', 'browser', 'main'].filter(
          isTruthy
        ),
        extensions: ['.mjs', '.cjs', '.js', '.json'], // Default: [ '.mjs', '.js', '.json', '.node' ]
        // whether to prefer built-in modules (e.g. `fs`, `path`) or local ones with the same names
        preferBuiltins: true, // Default: true
        dedupe: userDefinedRollup.dedupe,
      }),
      rollupPluginCommonjs({
        extensions: ['.js', '.cjs'],
        externalEsm: process.env.EXTERNAL_ESM_PACKAGES || [],
        requireReturnsDefault: 'auto',
      } as RollupCommonJSOptions),
    ].filter(Boolean) as Plugin[],
    onwarn(warning: any, warn: any) {
      // Warn about the first circular dependency, but then ignore the rest.
      if (warning.code === 'CIRCULAR_DEPENDENCY') {
        if (!isCircularImportFound) {
          isCircularImportFound = true;
          console.warn(
            `Warning: 1+ circular dependencies found via "${warning.importer}".`
          );
        }
        return;
      }
      // Log "unresolved" import warnings as an error, causing Snowpack to fail at the end.
      if (
        warning.code === 'PLUGIN_WARNING' &&
        warning.plugin === 'snowpack:rollup-plugin-catch-unresolved'
      ) {
        isFatalWarningFound = true;
        // Display posix-style on all environments, mainly to help with CI :)
        if (warning.id) {
          const fileName = path.relative(cwd, warning.id).replace(/\\/g, '/');
          console.error(`${fileName}\n   ${warning.message}`);
        } else {
          console.error(`${warning.message}.`);
        }
        return;
      }
      warn(warning);
    },
  };
  const outputOptions: OutputOptions = {
    dir: destLoc,
    format: 'esm',
    sourcemap: sourceMap,
    exports: 'named',
    chunkFileNames: 'common/[name]-[hash].js',
  };
  if (Object.keys(installEntrypoints).length > 0) {
    try {
      const packageBundle = await rollup(inputOptions);
      console.debug(
        `installing npm packages:\n    ${Object.keys(installEntrypoints).join(
          '\n    '
        )}`
      );
      if (isFatalWarningFound) {
        throw new Error();
      }
      await packageBundle.write(outputOptions);
    } catch (_err) {
      const err: Error = _err;
      const errFilePath = err.loc?.file || err.id;
      if (!errFilePath) {
        throw err;
      }
      // NOTE: Rollup will fail instantly on most errors. Therefore, we can
      // only report one error at a time. `err.watchFiles` also exists, but
      // for now `err.loc.file` and `err.id` have all the info that we need.
      // const failedExtension = path.extname(errFilePath);
      const suggestion = err.message;
      // Display posix-style on all environments, mainly to help with CI :)
      const fileName = path.relative(cwd, errFilePath).replace(/\\/g, '/');
      console.error(`Failed to load ${fileName}\n  ${suggestion}`);
      throw new Error();
    }
  }

  mkdir('-p', destLoc);
  await writeLockfile(path.join(destLoc, 'import-map.json'), importMap);
  for (const [assetName, assetLoc] of Object.entries(assetEntrypoints)) {
    const assetDest = `${destLoc}/${sanitizePackageName(assetName)}`;
    mkdir('-p', path.dirname(assetDest));
    fs.copyFileSync(assetLoc, assetDest);
  }

  return {
    success: true,
    importMap,
  };
}

export async function getInstallTargets(
  config: any,
  scannedFiles?: SourceFile[]
) {
  const { knownEntrypoints, webDependencies } = config;
  const installTargets: InstallTarget[] = [];
  if (knownEntrypoints) {
    installTargets.push(...scanDepList(knownEntrypoints, cwd));
  }
  if (webDependencies) {
    installTargets.push(...scanDepList(Object.keys(webDependencies), cwd));
  }
  if (scannedFiles) {
    installTargets.push(...(await scanImportsFromFiles(scannedFiles, config)));
  } else {
    installTargets.push(...(await scanImports(cwd, config)));
  }
  return installTargets;
}

export async function command(commandOptions: CommandOptions) {
  const { cwd, config } = commandOptions;

  const installTargets = await getInstallTargets(config);
  if (installTargets.length === 0) {
    console.error('Nothing to install.');
    return;
  }
  const finalResult = await run({ ...commandOptions, installTargets });
  if (finalResult.newLockfile) {
    await writeLockfile(
      path.join(cwd, 'snowpack.lock.json'),
      finalResult.newLockfile
    );
  }
  if (finalResult.stats) {
    console.info(finalResult.stats);
  }

  if (!finalResult.success || finalResult.hasError) {
    process.exit(1);
  }
}
export interface CommandOptions {
  cwd: string;
  config: any;
  lockfile: ImportMap | null;
  pkgManifest: any;
}
interface InstallRunOptions extends CommandOptions {
  installTargets: InstallTarget[];
}

interface InstallRunResult {
  success: boolean;
  hasError: boolean;
  importMap: ImportMap | null;
  newLockfile: ImportMap | null;
  stats: DependencyStatsOutput | null;
}
export async function run({
  config,
  // lockfile,
  installTargets,
}: InstallRunOptions): Promise<InstallRunResult> {
  const {
    installOptions: { dest },
    // webDependencies,
  } = config;

  // start
  const installStart = performance.now();
  console.info('! installing dependencies…');

  installResults = [];
  dependencyStats = null;

  if (installTargets.length === 0) {
    return {
      success: true,
      hasError: false,
      importMap: { imports: {} } as ImportMap,
      newLockfile: null,
      stats: null,
    };
  }

  let newLockfile: ImportMap | null = null;
  // if (webDependencies && Object.keys(webDependencies).length > 0) {
  //   newLockfile = await resolveTargetsFromRemoteCDN(lockfile, config).catch(
  //     (err: Error) => {
  //       console.error('\n' + err.message || err);
  //       process.exit(1);
  //     }
  //   );
  // }

  rm('-rf', dest);
  const finalResult = await install(installTargets, {
    lockfile: newLockfile,
    config,
  }).catch(err => {
    if (err.loc) {
      console.error(`✘ ${err.loc.file}`);
    }
    if (err.url) {
      console.error(`👉 ${err.url}`);
    }
    console.error(err.message || err);
    process.exit(1);
  });

  // finish
  const installEnd = performance.now();
  const depList =
    (finalResult.importMap && Object.keys(finalResult.importMap.imports)) || [];
  console.info(
    `${
      depList.length
        ? '✔ install complete'
        : 'install skipped (nothing to install)'
    } ${`[${((installEnd - installStart) / 1000).toFixed(2)}s]`}`
  );

  return {
    success: true,
    hasError: false,
    importMap: finalResult.importMap,
    newLockfile,
    stats: dependencyStats!,
  };
}
let dependencyStats: DependencyStatsOutput | null = null;
/**
 * UTILS
 */
export type DependencyStatsMap = {
  [filePath: string]: DependencyStats;
};

export type DependencyStatsOutput = Record<DependencyType, DependencyStatsMap>;
export type DependencyStats = {
  size: number;
  gzip: number;
  brotli?: number;
  delta?: number;
};

/** Get the package name + an entrypoint within that package (if given). */
export function parsePackageImportSpecifier(
  imp: string
): [string, string | null] {
  const impParts = imp.split('/');
  if (imp.startsWith('@')) {
    const [scope, name, ...rest] = impParts;
    return [`${scope}/${name}`, rest.join('/') || null];
  }
  const [name, ...rest] = impParts;
  return [name, rest.join('/') || null];
}

export function resolveDependencyManifest(
  dep: string,
  cwd: string
): [string | null, any | null] {
  // Attempt #1: Resolve the dependency manifest normally. This works for most
  // packages, but fails when the package defines an export map that doesn't
  // include a package.json. If we detect that to be the reason for failure,
  // move on to our custom implementation.
  try {
    const depManifest = require.resolve(`${dep}/package.json`, {
      paths: [cwd],
    });
    return [depManifest, require(depManifest)];
  } catch (err) {
    // if its an export map issue, move on to our manual resolver.
    if (err.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      return [null, null];
    }
  }

  // Attempt #2: Resolve the dependency manifest manually. This involves resolving
  // the dep itself to find the entrypoint file, and then haphazardly replacing the
  // file path within the package with a "./package.json" instead. It's not as
  // thorough as Attempt #1, but it should work well until export maps become more
  // established & move out of experimental mode.
  let result = [null, null] as [string | null, any | null];
  try {
    const fullPath = require.resolve(dep, { paths: [cwd] });
    // Strip everything after the package name to get the package root path
    // NOTE: This find-replace is very gross, replace with something like upath.
    const searchPath = `${path.sep}node_modules${path.sep}${dep.replace(
      '/',
      path.sep
    )}`;
    const indexOfSearch = fullPath.lastIndexOf(searchPath);
    if (indexOfSearch >= 0) {
      const manifestPath =
        fullPath.substring(0, indexOfSearch + searchPath.length + 1) +
        'package.json';
      result[0] = manifestPath;
      const manifestStr = fs.readFileSync(manifestPath, { encoding: 'utf-8' });
      result[1] = JSON.parse(manifestStr);
    }
  } catch (err) {
    // ignore
  } finally {
    return result;
  }
}

export function findMatchingAliasEntry(
  config: any,
  spec: string
): { from: string; to: string; type: 'package' | 'path' } | undefined {
  // Only match bare module specifiers. relative and absolute imports should not match
  if (
    spec.startsWith('./') ||
    spec.startsWith('../') ||
    spec.startsWith('/') ||
    spec.startsWith('http://') ||
    spec.startsWith('https://')
  ) {
    return undefined;
  }
  const foundEntry = Object.entries(config.alias).find(([fromAlias]) =>
    spec.startsWith(fromAlias)
  );
  if (!foundEntry) {
    return undefined;
  }
  return {
    from: foundEntry[0],
    to: foundEntry[1],
    type: isPackageAliasEntry(foundEntry[1]) ? 'package' : 'path',
  };
}
/**
 * For the given import specifier, return an alias entry if one is matched.
 */
export function isPackageAliasEntry(val: string): boolean {
  return !path.isAbsolute(val);
}
/**
 * Sanitizes npm packages that end in .js (e.g `tippy.js` -> `tippyjs`).
 * This is necessary because Snowpack can’t create both a file and directory
 * that end in .js.
 */
export function sanitizePackageName(filepath: string): string {
  const dirs = filepath.split('/');
  const file = dirs.pop() as string;
  return [...dirs.map(path => path.replace(/\.js$/i, 'js')), file].join('/');
}
export interface ImportMap {
  imports: { [packageName: string]: string };
}
export async function writeLockfile(
  loc: string,
  importMap: ImportMap
): Promise<void> {
  const sortedImportMap: ImportMap = { imports: {} };
  for (const key of Object.keys(importMap.imports).sort()) {
    sortedImportMap.imports[key] = importMap.imports[key];
  }
  fs.writeFileSync(loc, JSON.stringify(sortedImportMap, undefined, 2), {
    encoding: 'utf-8',
  });
}
function createInstallTarget(specifier: string, all = true): InstallTarget {
  return {
    specifier,
    all,
    default: false,
    namespace: false,
    named: [],
  };
}
export function scanDepList(depList: string[], cwd: string): InstallTarget[] {
  return depList
    .map(whitelistItem => {
      if (!glob.hasMagic(whitelistItem)) {
        return [createInstallTarget(whitelistItem, true)];
      } else {
        const nodeModulesLoc = path.join(cwd, 'node_modules');
        return scanDepList(
          glob.sync(whitelistItem, { cwd: nodeModulesLoc, nodir: true }),
          cwd
        );
      }
    })
    .reduce((flat, item) => flat.concat(item), []);
}
export interface SourceFile {
  /** base extension (e.g. `.js`) */
  baseExt: string;
  /** file contents */
  contents: string;
  /** expanded extension (e.g. `.proxy.js` or `.module.css`) */
  expandedExt: string;
  /** if no location on disk, assume this exists in memory */
  locOnDisk: string;
}
export async function scanImports(
  cwd: string,
  config: any
): Promise<InstallTarget[]> {
  await initESModuleLexer;
  const includeFileSets = await Promise.all(
    Object.keys(config.mount).map(fromDisk => {
      const dirDisk = path.resolve(cwd, fromDisk);
      return glob.sync(`**/*`, {
        ignore: config.exclude.concat(['**/web_modules/**/*']),
        cwd: dirDisk,
        absolute: true,
        nodir: true,
      });
    })
  );
  const includeFiles = Array.from(
    new Set(([] as string[]).concat.apply([], includeFileSets))
  );
  if (includeFiles.length === 0) {
    return [];
  }

  // Scan every matched JS file for web dependency imports
  const loadedFiles: (SourceFile | null)[] = await Promise.all(
    includeFiles.map(async filePath => {
      const { baseExt, expandedExt } = getExt(filePath);
      // Always ignore dotfiles
      if (filePath.startsWith('.')) {
        return null;
      }

      switch (baseExt) {
        // Probably a license, a README, etc
        case '': {
          return null;
        }
        // Our import scanner can handle normal JS & even TypeScript without a problem.
        case '.js':
        case '.ts': {
          return {
            baseExt,
            expandedExt,
            locOnDisk: filePath,
            contents: await fs.promises.readFile(filePath, 'utf-8'),
          };
        }
        case '.html': {
          const result = await fs.promises.readFile(filePath, 'utf-8');
          // TODO: Replace with matchAll once Node v10 is out of TLS.
          // const allMatches = [...result.matchAll(new RegExp(HTML_JS_REGEX))];
          const allMatches: string[][] = [];
          let match;
          let regex = new RegExp(HTML_JS_REGEX);
          while ((match = regex.exec(result))) {
            allMatches.push(match);
          }
          return {
            baseExt,
            expandedExt,
            locOnDisk: filePath,
            // match[2] is the code inside the <script></script> element
            contents: allMatches
              .map(match => match[2])
              .filter(s => s.trim())
              .join('\n'),
          };
        }
      }

      // If we don't recognize the file type, it could be source. Warn just in case.
      if (!mime.lookup(baseExt)) {
        console.warn(
          `ignoring unsupported file "${path
            .relative(process.cwd(), filePath)
            .replace(/\\/g, '/')}"`
        );
      }
      return null;
    })
  );
  return scanImportsFromFiles(loadedFiles.filter(isTruthy), config);
}
/** Get full extensions of files */
export function getExt(fileName: string) {
  return {
    /** base extension (e.g. `.js`) */
    baseExt: path.extname(fileName).toLocaleLowerCase(),
    /** full extension, if applicable (e.g. `.proxy.js`) */
    expandedExt: path
      .basename(fileName)
      .replace(/[^.]+/, '')
      .toLocaleLowerCase(),
  };
}
export async function scanImportsFromFiles(
  loadedFiles: SourceFile[],
  config: any
): Promise<InstallTarget[]> {
  return loadedFiles
    .map(parseCodeForInstallTargets)
    .reduce((flat, item) => flat.concat(item), [])
    .filter(target => {
      const aliasEntry = findMatchingAliasEntry(config, target.specifier);
      return !aliasEntry || aliasEntry.type === 'package';
    })
    .sort((impA, impB) => impA.specifier.localeCompare(impB.specifier));
}
function parseCodeForInstallTargets({
  locOnDisk,
  baseExt,
  contents,
}: SourceFile): InstallTarget[] {
  let imports: ImportSpecifier[];
  // Attempt #1: Parse the file as JavaScript. JSX and some decorator
  // syntax will break this.
  try {
    if (baseExt === '.jsx' || baseExt === '.tsx') {
      // We know ahead of time that this will almost certainly fail.
      // Just jump right to the secondary attempt.
      throw new Error('JSX must be cleaned before parsing');
    }
    [imports] = parse(contents) || [];
  } catch (err) {
    // Attempt #2: Parse only the import statements themselves.
    // This lets us guarentee we aren't sending any broken syntax to our parser,
    // but at the expense of possible false +/- caused by our regex extractor.
    try {
      contents = cleanCodeForParsing(contents);
      [imports] = parse(contents) || [];
    } catch (err) {
      // Another error! No hope left, just abort.
      console.error(`! ${locOnDisk}`);
      throw err;
    }
  }
  const allImports: InstallTarget[] = imports
    .map(imp => parseImportStatement(contents, imp))
    .filter(isTruthy)
    // Babel macros are not install targets!
    .filter(imp => !/[./]macro(\.js)?$/.test(imp.specifier));
  return allImports;
}
function cleanCodeForParsing(code: string): string {
  code = stripComments(code);
  const allMatches: string[] = [];
  let match;
  const importRegex = new RegExp(ESM_IMPORT_REGEX);
  while ((match = importRegex.exec(code))) {
    allMatches.push(match);
  }
  const dynamicImportRegex = new RegExp(ESM_DYNAMIC_IMPORT_REGEX);
  while ((match = dynamicImportRegex.exec(code))) {
    allMatches.push(match);
  }
  return allMatches.map(([full]) => full).join('\n');
}
/**
 * An install target represents information about a dependency to install.
 * The specifier is the key pointing to the dependency, either as a package
 * name or as an actual file path within node_modules. All other properties
 * are metadata about what is actually being imported.
 */
export type InstallTarget = {
  specifier: string;
  all: boolean;
  default: boolean;
  namespace: boolean;
  named: string[];
};
function parseImportStatement(
  code: string,
  imp: ImportSpecifier
): null | InstallTarget {
  const webModuleSpecifier = parseWebModuleSpecifier(
    getWebModuleSpecifierFromCode(code, imp)
  );
  if (!webModuleSpecifier) {
    return null;
  }

  const importStatement = code.substring(imp.ss, imp.se);
  if (/^import\s+type/.test(importStatement)) {
    return null;
  }

  const isDynamicImport = imp.d > -1;
  const hasDefaultImport =
    !isDynamicImport && DEFAULT_IMPORT_REGEX.test(importStatement);
  const hasNamespaceImport = !isDynamicImport && importStatement.includes('*');

  const namedImports = (importStatement.match(HAS_NAMED_IMPORTS_REGEX)! || [
    ,
    '',
  ])[1]
    .split(',') // split `import { a, b, c }` by comma
    .map(name => name.replace(STRIP_AS, '').trim()) // remove “ as …” and trim
    .filter(isTruthy);

  return {
    specifier: webModuleSpecifier,
    all:
      isDynamicImport ||
      (!hasDefaultImport && !hasNamespaceImport && namedImports.length === 0),
    default: hasDefaultImport,
    namespace: hasNamespaceImport,
    named: namedImports,
  };
}
function getWebModuleSpecifierFromCode(code: string, imp: ImportSpecifier) {
  // import.meta: we can ignore
  if (imp.d === -2) {
    return null;
  }
  // Static imports: easy to parse
  if (imp.d === -1) {
    return code.substring(imp.s, imp.e);
  }
  // Dynamic imports: a bit trickier to parse. Today, we only support string literals.
  const importStatement = code.substring(imp.s, imp.e);
  return matchImportSpecifier(importStatement);
}
export function isTruthy<T>(item: T | false | null | undefined): item is T {
  return Boolean(item);
}
export function matchImportSpecifier(importStatement: string) {
  const matched = importStatement.match(/^\s*('([^']+)'|"([^"]+)")\s*$/m);
  return matched?.[2] || matched?.[3] || null;
}
/**
 * parses an import specifier, looking for a web modules to install. If a web module is not detected,
 * null is returned.
 */
// [@\w] - Match a word-character or @ (valid package name)
// (?!.*(:\/\/)) - Ignore if previous match was a protocol (ex: http://)
const DEFAULT_IMPORT_REGEX = /import\s+(\w)+(,\s\{[\w\s]*\})?\s+from/s;
const STRIP_AS = /\s+as\s+.*/;
const HTML_JS_REGEX = /(<script.*?type="?module"?.*?>)(.*?)<\/script>/gms;
const ESM_IMPORT_REGEX = /import(?:["'\s]*([\w*${}\n\r\t, ]+)\s*from\s*)?\s*["'](.*?)["']/gm;
const ESM_DYNAMIC_IMPORT_REGEX = /(?<!\.)\bimport\((?:['"].+['"]|`[^$]+`)\)/gm;
const HAS_NAMED_IMPORTS_REGEX = /^[\w\s\,]*\{(.*)\}/s;
const BARE_SPECIFIER_REGEX = /^[@\w](?!.*(:\/\/))/;
const WEB_MODULES_TOKEN = 'web_modules/';
const WEB_MODULES_TOKEN_LENGTH = WEB_MODULES_TOKEN.length;
function parseWebModuleSpecifier(specifier: string | null): null | string {
  if (!specifier) {
    return null;
  }
  // If specifier is a "bare module specifier" (ie: package name) just return it directly
  if (BARE_SPECIFIER_REGEX.test(specifier)) {
    return specifier;
  }
  // Clean the specifier, remove any query params that may mess with matching
  const cleanedSpecifier = removeSpecifierQueryString(specifier);
  // Otherwise, check that it includes the "web_modules/" directory
  const webModulesIndex = cleanedSpecifier.indexOf(WEB_MODULES_TOKEN);
  if (webModulesIndex === -1) {
    return null;
  }

  // Check if this matches `@scope/package.js` or `package.js` format.
  // If it is, assume that this is a top-level pcakage that should be installed without the “.js”
  const resolvedSpecifier = cleanedSpecifier.substring(
    webModulesIndex + WEB_MODULES_TOKEN_LENGTH
  );
  const resolvedSpecifierWithoutExtension = stripJsExtension(resolvedSpecifier);
  if (
    validatePackageName(resolvedSpecifierWithoutExtension).validForNewPackages
  ) {
    return resolvedSpecifierWithoutExtension;
  }
  // Otherwise, this is an explicit import to a file within a package.
  return resolvedSpecifier;
}
function removeSpecifierQueryString(specifier: string) {
  const queryStringIndex = specifier.indexOf('?');
  if (queryStringIndex >= 0) {
    specifier = specifier.substring(0, queryStringIndex);
  }
  return specifier;
}
function stripJsExtension(dep: string): string {
  return dep.replace(/\.m?js$/i, '');
}
