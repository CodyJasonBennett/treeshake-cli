#!/usr/bin/env node
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as url from 'node:url'
import { createRequire } from 'node:module'
import { rollup } from 'rollup'
import virtual from '@rollup/plugin-virtual'
import MemoryFS from 'memory-fs'
import webpack from 'webpack'
import * as esbuild from 'esbuild'
import { Parcel } from '@parcel/core'
import * as acorn from 'acorn'

const require = createRequire(import.meta.url)

const bundlers = {
  async Rollup(file) {
    const bundle = await rollup({
      input: 'entry',
      plugins: [virtual({ entry: `import ${JSON.stringify(file)}` })],
      logLevel: 'silent',
    })

    const result = await bundle.generate({ format: 'esm' })

    return result.output[0].code
  },
  async Webpack(file) {
    const compiler = webpack({
      mode: 'production',
      entry: file,
      output: {
        filename: 'output.js',
        path: '/',
        module: true,
      },
      experiments: {
        outputModule: true,
      },
    })

    compiler.outputFileSystem = new MemoryFS()

    const code = await new Promise((resolve, reject) => {
      compiler.run((error, stats) => {
        if (error) return reject(error)

        if (stats.hasErrors()) {
          return reject(new Error(stats.toString({ errorDetails: true })))
        }

        resolve(compiler.outputFileSystem.data['output.js'].toString())
      })
    })

    return code
  },
  async ESBuild(file) {
    const { code } = await esbuild.transform(`import ${JSON.stringify(file)}`, {
      sourcemap: false,
      target: 'esnext',
      minify: true,
      treeShaking: true,
    })

    return code
  },
  async Parcel(file) {
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
    const distDir = path.resolve(__dirname, 'parcel-dist')

    const bundler = new Parcel({
      entries: file,
      defaultConfig: require.resolve('@parcel/config-default'),
      mode: 'production',
      defaultTargetOptions: {
        engines: {
          browsers: ['last 1 Chrome version'],
        },
        distDir,
        sourceMaps: false,
        includeNodeModules: false,
      },
      logLevel: 'error',
    })

    await bundler.run()

    // TODO: use @parcel/fs when workerpool works.
    // https://parceljs.org/features/parcel-api/#file-system
    const output = path.resolve(distDir, path.basename(file))
    const code = fs.readFileSync(output, 'utf-8')
    fs.rmSync(distDir, { recursive: true, force: true })
    fs.rmSync(path.resolve(process.cwd(), '.parcel-cache'), { recursive: true, force: true })

    return code
  },
}

try {
  const input = process.argv[2]
  const file = path.resolve(input)

  for (const bundler in bundlers) {
    const compile = bundlers[bundler]
    const code = await compile(file)

    const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' })

    for (const node of ast.body) {
      if (node.type !== 'ImportDeclaration') {
        console.log(code)
        throw `Couldn't tree-shake ${input} with ${bundler}!`
      }
    }
  }

  const formatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' })
  const targets = formatter.format(Object.keys(bundlers))

  console.info(`Successfully tree-shaken ${input} with ${targets}!`)
} catch (e) {
  console.error(e)
  process.exit(1)
}
