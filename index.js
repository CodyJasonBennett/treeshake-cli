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

let i = -1
let annotation = -1

function filterEffects(node, nodes = []) {
  i++

  if (node.type === 'Block' && (node.value.trim() === '@__PURE__' || node.value.trim() === '#__PURE__')) {
    annotation = i
  } else if (node.type === 'CallExpression' || node.type === 'NewExpression') {
    node.hasAnnotation = annotation !== -1 && annotation === i - 1

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

        const result = await esbuild.transform(fs.readFileSync(file, 'utf-8'), {
          sourcemap: false,
          target: 'esnext',
          minify: false,
          treeShaking: false,
        })

        const comments = []
        const ast = acorn.parse(result.code, {
          ecmaVersion: 'latest',
          sourceType: 'module',
          onComment: comments
        })

        const body = ast.body.concat(comments).sort((a, b) => a.start - b.start)
        const nodes = []
        for (const node of body) {
          filterEffects(node, nodes)
        }

        for (const node of nodes) {
          if (!node.hasAnnotation && (node.type === 'CallExpression' || node.type === 'NewExpression')) {
            const type = node.type === 'CallExpression' ? 'function' : 'class'
            console.error(`Top-level ${type} invocations must be annotated with /* @__PURE__ */!`)
          } else if (node.type === 'MemberExpression') {
            console.error('Top-level member expressions may call expressive code! Prefer destructuring.')
          }
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
