#!/usr/bin/env node
import * as path from 'node:path'
import { rollup } from 'rollup'
import virtual from '@rollup/plugin-virtual'
import MemoryFS from 'memory-fs'
import webpack from 'webpack'
import * as esbuild from 'esbuild'
import * as acorn from 'acorn'
import * as walk from 'acorn-walk'

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
}

const lineNumbers = (source, offset = 1, lines = source.split('\n').length) =>
  source.replace(/^/gm, () => `${offset++}:`.padStart(lines.toString().length + 3))

const hasIdent = (node) => node.type === 'AssignmentExpression' || node.type === 'PropertyDefinition'

function hasScope(node) {
  switch (node.type) {
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ObjectMethod':
    case 'ArrowFunctionExpression':
    case 'ClassMethod':
    case 'ClassPrivateMethod':
      return true
    case 'PropertyDefinition':
      return !node.static
    default:
      return false
  }
}

try {
  const input = process.argv[2]
  const file = path.resolve(input)

  await Promise.all(
    Object.entries(bundlers).map(async ([bundler, compile]) => {
      const code = await compile(file)

      const lines = lineNumbers(code).split('\n')
      const errors = []

      let maxLine = 0
      let maxColumn = 0

      function filterEffects(node, _state, ancestors) {
        let anonymous = true

        for (const ancestor of ancestors) {
          if (node.type === 'MemberExpression' && ancestor.type === 'CallExpression') return
          if (hasIdent(ancestor)) anonymous = false
          if (hasScope(ancestor)) return
        }

        let error = null

        if (node.type === 'CallExpression' || node.type === 'NewExpression') {
          const type = node.type === 'CallExpression' ? 'function' : 'class'
          error = anonymous
            ? `Anonymous ${type} invocations must be assigned a value and annotated with /* @__PURE__ */!`
            : `Top-level ${type} invocations must be annotated with /* @__PURE__ */!`
        } else if (node.type === 'MemberExpression') {
          error = 'Top-level member expressions may call code! Prefer destructuring or IIFE.'
        }

        if (error) {
          const { line, column } = node.loc.start
          lines[line - 1] = '>' + lines[line - 1].slice(1)
          maxLine = Math.max(maxLine, line.toString().length)
          maxColumn = Math.max(maxColumn, column.toString().length)
          errors.push({ line, column, error })
        }
      }

      const ast = acorn.parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        locations: true,
      })
      walk.ancestor(ast, {
        CallExpression: filterEffects,
        NewExpression: filterEffects,
        MemberExpression: filterEffects,
      })

      if (errors.length) {
        console.log(lines.join('\n'))
        for (const { line, column, error } of errors) {
          const _line = line.toString().padStart(maxLine)
          const _column = column.toString().padEnd(maxColumn)
          console.error(`${_line}:${_column} ${error}`)
        }

        throw `Couldn't tree-shake "${input}" with ${bundler}!`
      }
    }),
  )

  const formatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' })
  const targets = formatter.format(Object.keys(bundlers))

  console.info(`Successfully tree-shaken "${input}" with ${targets}!`)
} catch (e) {
  console.error(e)
  process.exit(1)
}
