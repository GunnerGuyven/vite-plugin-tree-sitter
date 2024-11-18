/*

vite-plugin-treesitter

based on
https://github.com/nshen/vite-plugin-treesitter/blob/main/src/index.ts
https://github.com/tree-sitter/tree-sitter/blob/master/cli/src/wasm.rs
https://github.com/tree-sitter/tree-sitter/blob/master/script/build-wasm

*/

import fs from 'fs';
import path from 'path';

import child_process from 'child_process';

/*
vite.config.js

import treeSitterPlugin from 'vite-plugin-tree-sitter';

  plugins: [
    treeSitterPlugin([
      'tree-sitter-javascript', // npm package
      './path/within/project/to/tree-sitter-html', // local package
      '../path/outside/project/to/tree-sitter-sqlite', // local package
      '/absolute/path/to/tree-sitter-go', // local package
    ]),
  ],
*/

export default function (packages, options) {

  // parse arguments
  if (!packages) packages = [];
  if (!options) options = { alwaysRebuild: false };

  const localPathList = [];
  const npmPathList = [];

  for (const path of packages) {
    if (path.startsWith('./') || path.startsWith('../') || path.startsWith('/'))	{
      localPathList.push(path)
    } else {
      npmPathList.push(path)
    }
  }

  const prefix = `@vite-plugin-tree-sitter@`;
  const wasmPackOutputPath = 'pkg'; // TODO

  // from ../../my-crate  ->  my_crate_bg.wasm
  const wasmNameOfPath = (localPath) => {
    return path.basename(localPath).replace(/\-/g, '_') + '_bg.wasm'; // TODO why _bg ?
  };

  // filename -> { path, isNodeModule }
  // TODO filename collisions?
  const wasmMap = new Map();

  // TODO better?
  // at least make sure that path exists
  wasmMap.set(
    'tree-sitter.wasm',
    {
      path: 'node_modules/web-tree-sitter/tree-sitter.wasm',
      isNodeModule: true
    }
  );

  // 'my_crate_bg.wasm': {path:'../../my_crate/pkg/my_crate_bg.wasm', isNodeModule: false}
  localPathList.forEach((localPath) => {
    const wasmName = wasmNameOfPath(localPath);
    const wasm = {
      path: path.join(localPath, wasmPackOutputPath, wasmName),
      isNodeModule: false
    };
    wasmMap.set(wasmName, wasm);
  });

  // 'my_crate_bg.wasm': { path: 'node_modules/my_crate/my_crate_bg.wasm', isNodeModule: true }
  npmPathList.forEach((npmPath) => {
    const wasmName = wasmNameOfPath(npmPath);
    const wasm = {
      path: path.join('node_modules', npmPath, wasmName),
      isNodeModule: true
    };
    wasmMap.set(wasmName, wasm);
  });

  let config_base;
  let config_assetsDir;



  return { // plugin object

    name: 'vite-plugin-tree-sitter',
    enforce: 'pre',

    configResolved(resolvedConfig) {
      config_base = resolvedConfig.base;
      config_assetsDir = resolvedConfig.build.assetsDir;
    },

    resolveId(id) {
      //console.log(`vite-plugin-tree-sitter: resolveId? ${id}`)
      if (id.includes('.wasm')) {
        console.log(`vite-plugin-tree-sitter: resolveId? ${id}`);
      }
      for (let i = 0; i < localPathList.length; i++) {
        if (path.basename(localPathList[i]) === id) {
          console.log(`vite-plugin-tree-sitter: resolveId! ${id}`)
          return prefix + id;
        }
      }
      return null;
    },

    async load(id) {
      //console.log(`vite-plugin-tree-sitter: load? ${id}`)
      if (id.includes('.wasm')) {
        console.log(`vite-plugin-tree-sitter: load? ${id}`)
      }
      if (id.startsWith(prefix)) {
        console.log(`vite-plugin-tree-sitter: load! ${id}`)
        id = id.slice(prefix.length);
        const modulejs = path.join(
          './node_modules',
          id,
          id.replace(/\-/g, '_') + '.js'
        );
        console.log(`vite-plugin-tree-sitter: load: read code from ${modulejs}`)
        const code = await fs.promises.readFile(modulejs, {
          encoding: 'utf8'
        });
        return code;
      }
    },

    async buildStart(_inputOptions) {
      async function prepareBuild(pkgPath, isNodeModule) {
        const pkgPathFull = isNodeModule
          ? path.join('node_modules', pkgPath)
          : path.join(pkgPath);
        const pkgName = path.basename(pkgPath);
        if (!fs.existsSync(pkgPathFull)) {
          if (isNodeModule) {
            console.error(`vite-plugin-tree-sitter: cannot find npm module ${pkgPathFull}`);
          } else {
            console.error(`vite-plugin-tree-sitter: cannot find local module ${pkgPathFull}`);
          }
        }
        if (!isNodeModule) {
          // copy pkg generated by treesitter to node_modules
          try {
            await fs.copy(pkgPath, path.join('node_modules', pkgName));
          } catch (error) {
            console.error(`copy crates failed`);
          }
        }

        // compile if necessary
        const grammar_name = (pkgName.match(/^tree-sitter-(.+)$/) || [])[1];
        if (!grammar_name) {
          console.error(`vite-plugin-tree-sitter: cannot parse tree-sitter grammar_name from pkgName ${pkgName}`);
        }
        //const outDir = 'node_modules/.vite'; // this folder is removed by vite
        const outDir = options.outDir || 'dist/assets';
        if (!fs.existsSync(outDir)) {
          fs.mkdirSync(outDir, { recursive: true });
        }
        const outBasePath = `${outDir}/tree-sitter-${grammar_name}`;
        //const outJsPath = `${outBasePath}.js`;
        const outWasmPath = `${outBasePath}.wasm`;

        if(options.alwaysRebuild || !fs.existsSync(outWasmPath)) {
          const sourceFileArgs = [`${pkgPathFull}/src/parser.c`];
          if (fs.existsSync(`${pkgPathFull}/src/scanner.cc`)) {
            sourceFileArgs.push("-xc++", `${pkgPathFull}/src/scanner.cc`);
          } else if (fs.existsSync(`${pkgPathFull}/src/scanner.cpp`)) {
            sourceFileArgs.push("-xc++", `${pkgPathFull}/src/scanner.cpp`);
          } else if (fs.existsSync(`${pkgPathFull}/src/scanner.c`)) {
            sourceFileArgs.push(`${pkgPathFull}/src/scanner.c`);
          }

          // based on https://github.com/tree-sitter/tree-sitter/blob/master/cli/src/wasm.rs
          // last updated: 2024-11-10 
          const compileArgs = [
            'emcc',
            '-v', // verbose
            '-Os',
            '-fno-exceptions',
            '-s', 'WASM=1',
            '-s', 'SIDE_MODULE=2', // produce only *.wasm file -> is only a "side module" for other *.wasm file
            '-s', 'TOTAL_MEMORY=33554432',
            '-s', 'NODEJS_CATCH_EXIT=0',
            '-s', 'NODEJS_CATCH_REJECTION=0',
            '-s', `EXPORTED_FUNCTIONS=["_tree_sitter_${grammar_name}"]`,
            /* debug
            '-s', 'ASSERTIONS=1',
            '-s', 'SAFE_HEAP=1',
            */
            //'-o', outJsPath, // passing *.js will produce *.js and *.wasm files
            '-o', outWasmPath,
            '-I', `${pkgPathFull}/src`,
            ...sourceFileArgs
          ];
          if(options.cacheDir){
            compileArgs.push('--cache', options.cacheDir)
          }
          console.log(`vite-plugin-tree-sitter: compile ${pkgPathFull} -> ${outWasmPath}`)
          const emccEnv = { ...process.env };
          delete emccEnv.NODE; // fix warning: honoring legacy environment variable `NODE`
          const emccProcess = child_process.spawnSync(compileArgs[0], compileArgs.slice(1), {
            stdio: [null, 'pipe', 'pipe'],
            //stdio: 'inherit',
            env: emccEnv,
            encoding: 'utf8'
          });
          function printEmccOutput() {
            console.log('emcc output:');
            console.log(emccProcess.stdout);
            console.log('emcc error:');
            console.log(emccProcess.stderr);
          }
          if (emccProcess.status != 0) {
            console.error(`vite-plugin-tree-sitter: buildStart: compile error: code ${emccProcess.status}`)
            if (emccProcess.status == null) {
              console.error(`vite-plugin-tree-sitter: buildStart: compile error: emcc not found?`)
            }
            printEmccOutput();
          }
          if (!fs.existsSync(outWasmPath)) {
            console.error(`vite-plugin-tree-sitter: buildStart: compile error: output file is missing`)
            printEmccOutput();
          }
        } else {
          console.log(`vite-plugin-tree-sitter: Skipped build of 'tree-sitter-${grammar_name}.wasm' Output already exists`)
          console.log("vite-plugin-tree-sitter: To force rebuild manually delete the output file(s) or use plugin option 'alwaysRebuild'")
        }
        /*
        else {
          console.error(`vite-plugin-tree-sitter: buildStart: compile ok: ${outWasmPath}`)
        }
        */

        wasmMap.set(path.basename(outWasmPath), { path: outWasmPath, isNodeModule });
      };

      for await (const localPath of localPathList) {
        await prepareBuild(localPath, false);
      }

      for await (const localPath of npmPathList) {
        await prepareBuild(localPath, true);
      }
    },

    configureServer({ middlewares }) {
        // send 'root/pkg/xxx.wasm' file to user
        middlewares.use((req, res, next) => {
          if (req.url) {
            console.log(req.url)
            const urlName = path.basename(req.url);
            res.setHeader(
              'Cache-Control',
              'no-cache, no-store, must-revalidate'
            );
            const wasm = wasmMap.get(urlName);
            if (wasm) {
              console.log(`vite-plugin-tree-sitter: serve ${req.url} -> ${wasm.path}`)
              res.writeHead(200, { 'Content-Type': 'application/wasm' });
              fs.createReadStream(wasm.path).pipe(res);
            } else {
              next();
            }
          }
        });
    },

    // TODO ...
    /* this kills the vite devserver when its trying to restart (after config reload)
    buildEnd() {
      // copy xxx.wasm files to /assets/xxx.wasm
      wasmMap.forEach((crate, fileName) => {
        this.emitFile({
          type: 'asset',
          fileName: `assets/${fileName}`,
          source: fs.readFileSync(crate.path)
        });
      });
    }
    */
  };
}
