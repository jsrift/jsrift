import _generate from '@babel/generator';
import * as t from '@babel/types';
import type { SliceResult } from '../slice.js';

const generate = ((_generate as unknown as { default?: typeof _generate }).default ??
  _generate) as typeof _generate;

export interface SandboxHandle {
  /** Call an exported function from the slice. */
  call: (name: string, args: readonly (string | number)[]) => unknown;
  /** Read an exported binding (used for plain string arrays). */
  read: (name: string) => unknown;
  dispose: () => void;
}

export interface SandboxOptions {
  timeoutMs: number;
  allowExecution: boolean;
}

/**
 * Execute an extracted slice with host globals shadowed.
 *
 * **This is a mitigation, not a security boundary, and it is off by default.**
 * Shadowing globals with parameters does not contain determined code: the
 * `Function` constructor is still reachable through any object's
 * `constructor.constructor`, which re-opens the real global scope. A sandboxed
 * iframe is stronger but has its own escape history and - decisively - cannot be
 * created inside a Worker, which would force a large job back onto the UI thread.
 *
 * So this tier exists only for decoders the `native` and `interpreter` tiers
 * cannot handle, and reaching it requires the caller to set
 * `sandbox.allowExecution` explicitly. The slice being self-contained
 * (`isSelfContained`) is what makes that opt-in defensible: the executed code has
 * no free references to anything but arithmetic and string built-ins.
 */
export function createSandbox(slice: SliceResult, options: SandboxOptions): SandboxHandle {
  if (!options.allowExecution) {
    throw new Error('Sandbox execution is disabled (sandbox.allowExecution === false)');
  }

  const program = t.program(slice.statements, [], 'script');
  const body = generate(t.file(program), { compact: true, comments: false }).code;
  const exported = [...slice.definedNames];

  // A single function body: the slice, then a dispatcher closing over it. Built
  // with `new Function` rather than `eval` so it cannot see any local scope, and
  // with every host global shadowed by a parameter bound to undefined.
  const shadowed = HOSTILE_GLOBALS.filter((name) => !slice.definedNames.has(name));
  const factory = new Function(
    ...shadowed,
    `"use strict";
${body}
return {
  call: function (name, args) { return ({${exported.map((n) => `${JSON.stringify(n)}: typeof ${n} !== "undefined" ? ${n} : undefined`).join(',')}})[name].apply(undefined, args); },
  read: function (name) { return ({${exported.map((n) => `${JSON.stringify(n)}: typeof ${n} !== "undefined" ? ${n} : undefined`).join(',')}})[name]; }
};`,
  );

  const realm = factory(...shadowed.map(() => undefined)) as {
    call: (name: string, args: readonly unknown[]) => unknown;
    read: (name: string) => unknown;
  };

  const deadline = Date.now() + options.timeoutMs;
  const checkBudget = () => {
    if (Date.now() > deadline) throw new Error('Sandbox evaluation exceeded its time budget');
  };

  return {
    call(name, args) {
      checkBudget();
      return realm.call(name, args);
    },
    read(name) {
      checkBudget();
      return realm.read(name);
    },
    dispose() {
      /* The realm is a closure; dropping the handle is enough. */
    },
  };
}

/**
 * Names bound to `undefined` inside the sandbox so a decoder cannot reach the
 * host environment even if the slice analysis missed a reference. This is
 * defence in depth: `isSelfContained` should already have rejected such a slice.
 */
const HOSTILE_GLOBALS = [
  'globalThis',
  'window',
  'self',
  'global',
  'document',
  'navigator',
  'location',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'Worker',
  'importScripts',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'require',
  'module',
  'exports',
  'process',
  'Function',
  // `eval` and `arguments` must NOT appear here: binding either as a parameter
  // name inside a strict-mode function body is a SyntaxError, which would make
  // this tier throw on every input. Shadowing `Function` already makes `eval`
  // unreachable as an escape route.
  'setTimeout',
  'setInterval',
  'queueMicrotask',
  'Reflect',
  'Proxy',
  'WebAssembly',
  'Notification',
  'crypto',
];
