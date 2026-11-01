/**
 * Collects the strings a user can read from the TSX under `src/pages` and
 * `src/components`, using the TypeScript parser rather than a grep so comments,
 * imports, identifiers and object keys are never mistaken for copy.
 *
 * "User-facing" means:
 *  - JSX text (`<p>Hello</p>`);
 *  - string and template literals inside a JSX expression (`{ok ? 'Saved' : 'Failed'}`);
 *  - string values of text-bearing JSX props (placeholder, aria-label, title, alt, label, ...);
 *  - arguments of message sinks: `alert`, `confirm`, `toast*`, `notify*`, and any
 *    `set…Error` / `set…Message` / `set…Status` / `set…Notice` state setter;
 *  - `new Error('…')` thrown from a page or component, because those land in a
 *    `setError(e.message)` sooner or later.
 *
 * Shared by the #324 guard test. Kept beside it rather than in `src/lib` because
 * nothing in the app needs it at runtime.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

export type UserString = { file: string; line: number; text: string }

const TEXT_PROPS = new Set([
  'placeholder',
  'aria-label',
  'aria-description',
  'title',
  'alt',
  'label',
  'kicker',
  'description',
  'helper',
  'hint',
  'caption',
  'message',
  'subtitle',
  'emptyText',
  'confirmLabel',
  'cancelLabel',
])

const SINK = /^(alert|confirm|toast\w*|notify\w*|show\w*Toast|set\w*(Error|Message|Status|Notice|Toast|Hint))$/

function walkFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === '__tests__') continue
      out.push(...walkFiles(p))
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

function literalTexts(node: ts.Node): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].filter(Boolean)
  }
  return []
}

/** Every string/template literal under `node`, not descending into nested JSX (visited on its own). */
function nestedLiterals(node: ts.Node, sf: ts.SourceFile, file: string, out: UserString[]) {
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) return
    // A call inside a JSX expression is a function's argument, not copy: `cn('px-2')`,
    // `t.format('x')`. Only its result could be text, and that is code.
    if (ts.isCallExpression(n) && !isSinkCall(n)) return
    // Comparisons are code: `{kind === 'relay' && …}`.
    if (
      ts.isBinaryExpression(n) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(n.operatorToken.kind)
    )
      return
    if (ts.isElementAccessExpression(n)) return
    for (const text of literalTexts(n)) {
      out.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text })
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
}

function isConsoleCall(n: ts.Node): boolean {
  return (
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    ts.isIdentifier(n.expression.expression) &&
    n.expression.expression.text === 'console'
  )
}

function isComparison(n: ts.Node): boolean {
  return (
    ts.isBinaryExpression(n) &&
    [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
    ].includes(n.operatorToken.kind)
  )
}

function isProse(n: ts.Node): boolean {
  if (!(ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n))) return false
  // A literal that is part of a larger visited sink was already collected; the
  // dedupe in the caller keeps one copy.
  if (ts.isLiteralTypeNode(n.parent)) return false
  return literalTexts(n).some((t) => /\S\s+\S/.test(t))
}

function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return undefined
}

function isSinkCall(n: ts.CallExpression): boolean {
  const name = calleeName(n)
  return !!name && SINK.test(name)
}

export function collectUserStrings(root: string, dirs: string[]): UserString[] {
  const out: UserString[] = []
  for (const dir of dirs) {
    for (const abs of walkFiles(join(root, dir))) {
      const file = relative(root, abs)
      const source = readFileSync(abs, 'utf8')
      const sf = ts.createSourceFile(abs, source, ts.ScriptTarget.Latest, true, abs.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
      const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
      const visit = (n: ts.Node) => {
        if (ts.isJsxText(n)) {
          const text = n.text.replace(/\s+/g, ' ').trim()
          if (text) out.push({ file, line: lineOf(n), text })
        } else if (ts.isJsxExpression(n) && n.expression && !ts.isJsxAttribute(n.parent)) {
          nestedLiterals(n.expression, sf, file, out)
        } else if (ts.isJsxAttribute(n)) {
          const name = n.name.getText(sf)
          if (TEXT_PROPS.has(name) && n.initializer) {
            if (ts.isStringLiteral(n.initializer)) out.push({ file, line: lineOf(n), text: n.initializer.text })
            else if (ts.isJsxExpression(n.initializer) && n.initializer.expression) {
              nestedLiterals(n.initializer.expression, sf, file, out)
            }
          }
        } else if (ts.isCallExpression(n) && isSinkCall(n)) {
          for (const arg of n.arguments) nestedLiterals(arg, sf, file, out)
        } else if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Error') {
          for (const arg of n.arguments ?? []) nestedLiterals(arg, sf, file, out)
        } else if (isConsoleCall(n) || ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || isComparison(n)) {
          // Developer output and module specifiers: never rendered.
          return
        } else if (isProse(n)) {
          // Copy held in a constant or a helper (`const HINT = 'Paste your …'`)
          // reaches the screen just as surely. Prose (it has a space) is the
          // tell; a bare 'relay' discriminator or a className has no such term.
          for (const text of literalTexts(n)) out.push({ file, line: lineOf(n), text })
        }
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }
  }
  const seen = new Set<string>()
  return out.filter((s) => {
    const k = `${s.file}:${s.line}:${s.text}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
