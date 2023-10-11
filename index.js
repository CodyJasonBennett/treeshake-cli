#!/usr/bin/env node
import * as path from 'node:path'
import * as fs from 'node:fs'
import { rollup } from 'rollup'
import virtual from '@rollup/plugin-virtual'
import MemoryFS from 'memory-fs'
import webpack from 'webpack'
import * as esbuild from 'esbuild'
import * as acorn from 'acorn'

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

const builtins = [
  'Array',
  'Array.isArray',
  'ArrayBuffer',
  'ArrayBuffer.isView',
  'Boolean',
  'DataView',
  'Date',
  'Date.UTC',
  'Date.now',
  'Date.parse',
  'Error',
  'EvalError',
  'Float32Array',
  'Float64Array',
  'Function',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'InternalError',
  'Intl.Collator',
  'Intl.Collator.supportedLocalesOf',
  'Intl.DateTimeFormat',
  'Intl.DateTimeFormat.supportedLocalesOf',
  'Intl.NumberFormat',
  'Intl.NumberFormat.supportedLocalesOf',
  'JSON.parse',
  'JSON.stringify',
  'Map',
  'Math.abs',
  'Math.acos',
  'Math.acosh',
  'Math.asin',
  'Math.asinh',
  'Math.atan',
  'Math.atan2',
  'Math.atanh',
  'Math.cbrt',
  'Math.ceil',
  'Math.clz32',
  'Math.cos',
  'Math.cosh',
  'Math.exp',
  'Math.expm1',
  'Math.floor',
  'Math.fround',
  'Math.hypot',
  'Math.imul',
  'Math.log',
  'Math.log10',
  'Math.log1p',
  'Math.log2',
  'Math.max',
  'Math.min',
  'Math.pow',
  'Math.random',
  'Math.round',
  'Math.sign',
  'Math.sin',
  'Math.sinh',
  'Math.sqrt',
  'Math.tan',
  'Math.tanh',
  'Math.trunc',
  'Number',
  'Number.isFinite',
  'Number.isInteger',
  'Number.isNaN',
  'Number.isSafeInteger',
  'Number.parseFloat',
  'Number.parseInt',
  'Object',
  'Object.create',
  'Object.getNotifier',
  'Object.getOwn',
  'Object.getOwnPropertyDescriptor',
  'Object.getOwnPropertyNames',
  'Object.getOwnPropertySymbols',
  'Object.getPrototypeOf',
  'Object.is',
  'Object.isExtensible',
  'Object.isFrozen',
  'Object.isSealed',
  'Object.keys',
  'Promise',
  'Promise.all',
  'Promise.race',
  'Promise.reject',
  'Promise.resolve',
  'RangeError',
  'ReferenceError',
  'RegExp',
  'Set',
  'String',
  'String.fromCharCode',
  'String.fromCodePoint',
  'String.raw',
  'Symbol',
  'Symbol.for',
  'Symbol.keyFor',
  'SyntaxError',
  'TypeError',
  'URIError',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'WeakMap',
  'WeakSet',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'isFinite',
  'isNaN',
  'parseFloat',
  'parseInt',
  'unescape',
]

function filterEffects(node, nodes = []) {
  if (node.type === 'Block' && (node.value.trim() === '@__PURE__' || node.value.trim() === '#__PURE__')) {
    nodes.push(node)
  } else if (node.type === 'CallExpression' || node.type === 'NewExpression') {
    nodes.push(node)
    for (const argument of node.arguments) {
      filterEffects(argument, nodes)
    }
  } else if (node.type === 'MemberExpression') {
    nodes.push(node)
  } else if (node.type === 'ExpressionStatement') {
    filterEffects(node.expression, nodes)
  } else if (node.type === 'VariableDeclaration') {
    for (const declaration of node.declarations) {
      filterEffects(declaration, nodes)
    }
  } else if (node.type === 'VariableDeclarator') {
    node.init.hasValue = true
    filterEffects(node.init, nodes)
  } else if (node.type === 'AssignmentExpression' || node.type === 'BinaryExpression') {
    filterEffects(node.left, nodes)
    filterEffects(node.right, nodes)
  } else if (node.type === 'ObjectExpression') {
    for (const property of node.properties) {
      filterEffects(property, nodes)
    }
  } else if (node.type === 'Property') {
    filterEffects(node.key, nodes)
    filterEffects(node.value, nodes)
  } else if (node.type === 'ArrayExpression') {
    for (const element of node.elements) {
      filterEffects(element, nodes)
    }
  }
}

const lineNumbers = (source, offset = 1) => source.replace(/^/gm, () => `  ${offset++}:`)

async function lint(code) {
  const result = await esbuild.transform(code, {
    sourcemap: false,
    target: 'esnext',
    minify: false,
    treeShaking: false,
  })

  const comments = []
  const ast = acorn.parse(result.code, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    onComment: comments,
    locations: true,
  })

  let nodes = []
  for (const node of ast.body.concat(comments)) {
    filterEffects(node, nodes)
  }
  nodes = nodes.sort((a, b) => a.start - b.start)

  const lines = lineNumbers(result.code).split('\n')
  const errors = []

  let annotation = false

  for (const node of nodes) {
    let error = null

    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const name = node.callee.name || `${node.callee.object.name}.${node.callee.property.name}`
      const type = node.type === 'CallExpression' ? 'function' : 'class'
      const pure = annotation || builtins.includes(name)
      if (!pure && !node.hasValue) {
        error = `Top-level ${type} invocations must have a value or they will be discarded!`
      } else if (!pure) {
        error = `Top-level ${type} invocations must be annotated with /* @__PURE__ */!`
      }
    } else if (node.type === 'MemberExpression') {
      error = 'Top-level member expressions may call expressive code! Prefer destructuring.'
    }

    if (error) {
      const { line, column } = node.loc.start
      lines[line - 1] = '>' + lines[line - 1].slice(1)
      errors.push(`${line}:${column} ${error}`)
    }

    annotation = node.type === 'Block'
  }

  return { code: lines.join('\n'), errors }
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
        const { code, errors } = await lint(fs.readFileSync(file, 'utf-8'))

        console.log(code)
        for (const error of errors) {
          console.error(error)
        }

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
