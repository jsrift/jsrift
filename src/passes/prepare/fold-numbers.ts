import * as t from '@babel/types';
import type { Pass } from '../../pipeline/pass.js';

/**
 * Collapse purely-numeric constant arithmetic back to a single literal.
 *
 * This inverts obfuscator.io's `numbersToExpressions`, which rewrites every
 * constant as a small arithmetic tree - `357` becomes
 * `-0x3a3 + -0x1 * -0x25a2 + -0x209a`.
 *
 * It has to run in `prepare`, before anything analyses the tree, because
 * decoder recognition keys on constants: the `% 256` of an RC4 loop, the 64
 * characters of a base64 alphabet, an index offset. Those constants are what
 * make recognition independent of the identifier names an obfuscator randomises
 * on every run. Left as arithmetic, they are invisible, and a decoder that is
 * otherwise perfectly recognisable is missed entirely.
 *
 * `simplify.fold-constants` does a broader job later. This pass deliberately
 * handles only numbers, so it stays provably meaning-preserving on a tree
 * nothing has inspected yet.
 */
export const foldNumbersPass: Pass = {
  id: 'prepare.fold-numbers',
  title: 'Fold numeric constant arithmetic',
  stage: 'prepare',
  technique: 'literalSimplification',
  visitor: (ctx) => ({
    // `exit` so inner nodes fold first and the whole tree collapses in one walk.
    BinaryExpression: {
      exit(path) {
        const folded = fold(path.node);
        if (folded === undefined) return;
        path.replaceWith(t.inherits(literalFor(folded), path.node));
        path.skip();
        ctx.markChanged();
      },
    },
    UnaryExpression: {
      exit(path) {
        // `-1` is already the canonical spelling of the number -1: the generator
        // prints `t.numericLiteral(-1)` as `-1`, which re-parses as this very
        // node. Replacing it is a no-op that reports a change, so the pass never
        // reaches a fixpoint - measured on obfuscated4.out.js, a run whose
        // output is byte-identical to its input still reports 14,444 changes,
        // exactly the file's count of `-<numeric literal>` nodes. That corrupts
        // `totalChanges` as a metric and would spin forever any loop driven by
        // it. `simplify.fold-constants` refuses the same shape for the same
        // reason (see `foldUnary` there).
        //
        // Nothing downstream loses the value: every consumer reads numbers
        // through `staticNumber` (util/ast.ts) or `constantNumber`
        // (analysis/evaluator/native.ts), both of which read `-N` and `+N` as
        // well as a bare literal. The hex spelling of `-0x1` is not lost either;
        // `normalizeNumericForm` in `simplify.fold-constants` re-spells the
        // literal itself, and unlike this pass it declines when decimal is the
        // longer form (`-1e21` stays as written instead of becoming `-1e+21`).
        if (isCanonicalNegative(path.node)) return;
        const folded = fold(path.node);
        if (folded === undefined) return;
        path.replaceWith(t.inherits(literalFor(folded), path.node));
        path.skip();
        ctx.markChanged();
      },
    },
  }),
};

/**
 * The literal for a folded value, in the shape the parser gives that value.
 *
 * A negative number is `-` over a non-negative literal, and a NumericLiteral
 * whose `value` is negative is a node no parser produces. The generator prints
 * such a node as the bare digits with a sign in front and, because it is a
 * literal, never parenthesises it - so `(1 - 4) ** x` came out as `-3 ** x`,
 * which does not parse, and `(~2).toFixed(x)` as `-3 .toFixed(x)`, which parses
 * as `-(3 .toFixed(x))` and runs. The second is the worse outcome: verified
 * output computing a different value. Built as a UnaryExpression the generator
 * parenthesises it wherever the position needs it, and the exit handlers above
 * still see it as an operand: `-(1 - 5)` folds through the `-4` to `4`.
 * `simplify.fold-constants` spells its results the same way.
 */
function literalFor(value: number): t.Expression {
  return value < 0 ? t.unaryExpression('-', t.numericLiteral(-value)) : t.numericLiteral(value);
}

/**
 * Whether folding `node` would replace it with the spelling it already has:
 * `-` over a literal, the parser's own shape for a negative number and the one
 * `literalFor` produces, which the generator prints back unchanged.
 */
function isCanonicalNegative(node: t.UnaryExpression): boolean {
  return node.operator === '-' && t.isNumericLiteral(node.argument);
}

/**
 * Evaluate a node if - and only if - every leaf is a numeric literal and the
 * result is a plain, exactly-representable, positive-or-negative finite number.
 */
function fold(node: t.Node): number | undefined {
  const value = evaluate(node);
  if (value === undefined) return undefined;

  // A NumericLiteral cannot express -0: the generator prints `0`, which is a
  // different value under Object.is and 1/x.
  if (Object.is(value, -0)) return undefined;
  if (!Number.isFinite(value)) return undefined;
  // Beyond the safe integer range, folding can lose precision that the original
  // expression preserved through its intermediate steps.
  if (!Number.isSafeInteger(value) && !isExactFloat(value)) return undefined;

  return value;
}

function evaluate(node: t.Node): number | undefined {
  if (t.isNumericLiteral(node)) return node.value;

  if (t.isUnaryExpression(node)) {
    const argument = evaluate(node.argument);
    if (argument === undefined) return undefined;
    switch (node.operator) {
      case '-':
        return -argument;
      case '+':
        return argument;
      case '~':
        return ~argument;
      default:
        return undefined;
    }
  }

  if (t.isBinaryExpression(node)) {
    if (node.left.type === 'PrivateName') return undefined;
    const left = evaluate(node.left);
    if (left === undefined) return undefined;
    const right = evaluate(node.right);
    if (right === undefined) return undefined;

    switch (node.operator) {
      case '+':
        return left + right;
      case '-':
        return left - right;
      case '*':
        return left * right;
      case '/':
        return right === 0 ? undefined : left / right;
      case '%':
        return right === 0 ? undefined : left % right;
      case '**':
        return left ** right;
      case '&':
        return left & right;
      case '|':
        return left | right;
      case '^':
        return left ^ right;
      case '<<':
        return left << right;
      case '>>':
        return left >> right;
      case '>>>':
        return left >>> right;
      default:
        return undefined;
    }
  }

  return undefined;
}

/** A non-integer result is only safe to inline if it round-trips through text. */
function isExactFloat(value: number): boolean {
  return Number(String(value)) === value;
}
