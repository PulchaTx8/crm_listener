import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE } from '@/i18n/locales';

/**
 * Block 12c. What `catalogue.test.ts` cannot see.
 *
 * That file asks whether the three catalogues agree with each other. These ask
 * whether the CODE and the catalogue agree, which is a different question and
 * the one that was actually being got wrong: next-intl renders the key itself
 * when a message is absent, so a screen reading `music.actionsForSong` looks
 * like working software right up until somebody reads it.
 */

const SOURCE = join(process.cwd(), 'src');
const MESSAGES = join(process.cwd(), 'messages');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

const FUNCTIONISH = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor,
]);

describe('how the code reaches the catalogue', () => {
  /**
   * THE ONE THAT ALREADY CAUGHT A PRODUCTION-BREAKING DEFECT.
   *
   * `getTranslations` reads `cookies()`. A call in the module body runs when
   * the module first loads, which is outside any request, so `cookies()`
   * throws and the WHOLE route fails to initialise — not the one string, every
   * Server Action in the file.
   *
   * It reached CI as one line inside a Zod schema:
   *
   *     const archiveRequestSchema = z.object({
   *       requestId: z.string().uuid((await getTranslations('music'))('…')),
   *     });
   *
   * tsc allows it (top-level await is legal ESM), lint allows it, and a
   * brace-counting sweep called the file clean because the call sits three
   * braces deep. Only scope answers it, so this asks the AST.
   */
  it('never calls a translator outside a function', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SOURCE)) {
      const text = readFileSync(file, 'utf8');
      if (!/(get|use)Translations\(/.test(text)) continue;
      const sf = parse(file);

      const visit = (node: ts.Node, insideFunction: boolean): void => {
        if (
          !insideFunction &&
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          /^(get|use)Translations$/.test(node.expression.text)
        ) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
          offenders.push(`${file.replace(process.cwd(), '')}:${line + 1}`);
        }
        ts.forEachChild(node, (child) =>
          visit(child, insideFunction || FUNCTIONISH.has(node.kind)),
        );
      };

      visit(sf, false);
    }

    expect(offenders, 'a module body has no request behind it, so it has no cookie either').toEqual(
      [],
    );
  });

  /**
   * Every literal `t('key')` resolves in the namespace its own file asked for.
   *
   * Only files that BIND their translator are checked: one that receives it as
   * a parameter (the nine describe*Error functions, formatBucket,
   * childCountLabel) cannot be resolved from its own text, and guessing a
   * namespace for it would make this test lie rather than fail.
   */
  it('names a key that exists, everywhere a namespace is knowable', () => {
    const catalogue: Record<string, unknown> = JSON.parse(
      readFileSync(join(MESSAGES, `${DEFAULT_LOCALE}.json`), 'utf8'),
    );
    const missing: string[] = [];
    let checked = 0;

    for (const file of sourceFiles(SOURCE)) {
      const text = readFileSync(file, 'utf8');
      if (!/(get|use)Translations\(/.test(text)) continue;

      // Which namespace each translator name holds here. A name bound twice to
      // two namespaces is skipped rather than guessed.
      const namespaces = new Map<string, string | null>();
      for (const m of text.matchAll(
        /const (\w+) = (?:await )?(?:get|use)Translations\('([\w.]+)'\)/g,
      )) {
        const name = m[1]!;
        const ns = m[2]!;
        namespaces.set(name, namespaces.has(name) && namespaces.get(name) !== ns ? null : ns);
      }
      // A translator arriving as a parameter shadows any binding of that name.
      for (const m of text.matchAll(/(\w+): \(key: string[^)]*\) => string/g)) {
        namespaces.set(m[1]!, null);
      }

      for (const m of text.matchAll(/\b(\w+)(?:\.rich)?\('([A-Za-z]\w*)'/g)) {
        const translator = m[1]!;
        const key = m[2]!;
        const ns = namespaces.get(translator);
        if (!ns) continue;
        checked++;
        const bag = ns.split('.').reduce<unknown>((x, part) => {
          return x && typeof x === 'object' ? (x as Record<string, unknown>)[part] : undefined;
        }, catalogue);
        const value = bag && typeof bag === 'object' ? (bag as Record<string, unknown>)[key] : undefined;
        if (typeof value !== 'string') {
          missing.push(`${file.replace(process.cwd(), '')} → ${ns}.${key}`);
        }
      }
    }

    // A guard on the guard: a regex that silently stops matching would make
    // this test pass on an empty set.
    expect(checked).toBeGreaterThan(1000);
    expect(missing, 'next-intl renders the key itself when a message is absent').toEqual([]);
  });

  /**
   * Every message formats, in every language.
   *
   * A malformed plural in the Portuguese catalogue never renders in English, so
   * nothing else in this suite would reach it — the English branch is the only
   * one the e2e journeys exercise.
   */
  it('holds a message every language can format', async () => {
    const { createTranslator } = await import('next-intl');
    const failures: string[] = [];

    for (const locale of AVAILABLE_LOCALES) {
      const messages: Record<string, Record<string, unknown>> = JSON.parse(
        readFileSync(join(MESSAGES, `${locale}.json`), 'utf8'),
      );

      for (const [namespace, bag] of Object.entries(messages)) {
        const t = createTranslator({
          locale,
          messages,
          namespace,
          onError: () => {},
          getMessageFallback: ({ key, error }) => {
            failures.push(`${locale}/${namespace}.${key}: ${error.message.split('\n')[0]}`);
            return '';
          },
        });

        for (const [key, value] of Object.entries(bag)) {
          if (typeof value !== 'string') continue;
          // Every placeholder the message names, given a value of its type.
          const args: Record<string, unknown> = {};
          for (const m of value.matchAll(/\{(\w+)(,\s*(plural|number|date|time))?/g)) {
            const name = m[1]!;
            const kind = m[3];
            args[name] = kind === 'plural' || name === 'count' ? 2 : `«${name}»`;
          }
          // A rich-text tag takes a renderer, not a value.
          for (const m of value.matchAll(/<(\w+)>/g)) args[m[1]!] = (chunks: unknown) => chunks;

          const rich = /<\w+>/.test(value);
          const rendered = rich
            ? (t.rich as (k: string, a: Record<string, unknown>) => unknown)(key, args)
            : (t as unknown as (k: string, a: Record<string, unknown>) => string)(key, args);
          if (rendered === '') failures.push(`${locale}/${namespace}.${key}: rendered empty`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
