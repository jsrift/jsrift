import vm from 'node:vm';
import _traverse, { type NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { buildDecoder } from '../src/analysis/evaluator/index.js';
import {
  exciseStateObjectGuards,
  findGlobalObjectPrologue,
  findStateObjectGuards,
  recogniseFixedRotation,
  recogniseNativeDecoder,
} from '../src/analysis/evaluator/native.js';
import { sliceForEvaluation } from '../src/analysis/slice.js';
import { resolveConfig } from '../src/config/presets.js';
import { parseSource } from '../src/frontend/language.js';
import { deobfuscate } from '../src/index.js';
import type { Severity } from '../src/types.js';

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ??
  _traverse) as typeof _traverse;

/**
 * The obfuscator.io 0.x decoder template - the global-object idiom, the
 * `atob` polyfill, base64 or rc4 over percent-decoded UTF-8, the fixed-count
 * rotation with or without the `selfDefending` cookie machinery, and the
 * state object inside the decoder - generated here in the compact form the
 * obfuscator emitted, since its guards read the program's own text.
 * javascript-obfuscator 5.x no longer emits any of it.
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function execute(code: string, timeout = 5_000): string {
  const trace: string[] = [];
  const timers: (() => void)[] = [];
  const log = (...args: unknown[]): void => {
    trace.push(args.map((value) => (typeof value === 'string' ? JSON.stringify(value) : String(value))).join(' '));
  };
  const queue = (fn: () => void): number => timers.push(fn);
  try {
    vm.runInNewContext(
      code,
      vm.createContext({ log, atob, btoa, setTimeout: queue, setInterval: queue, clearInterval: () => undefined, clearTimeout: () => undefined }),
      { timeout },
    );
    for (let drained = 0; timers.length > 0 && drained < 32; drained++) timers.shift()!();
  } catch (error) {
    trace.push(`THROWN ${(error as Error).name}: ${(error as Error).message}`);
  }
  return trace.join('\n');
}

const PRESETS = ['conservative', 'balanced', 'aggressive'] as const;

function programPath(source: string): NodePath<t.Program> {
  const { ast } = parseSource(source);
  let found: NodePath<t.Program> | undefined;
  traverse(ast, {
    Program(path) {
      found = path;
      path.stop();
    },
  });
  if (!found) throw new Error('no Program path');
  found.scope.crawl();
  return found;
}

function build(source: string, roots: string[], preset: (typeof PRESETS)[number]) {
  const notes: { severity: Severity; message: string }[] = [];
  const decoder = buildDecoder(programPath(source), roots, resolveConfig({ preset }), {
    reporter: { note: (severity, message) => notes.push({ severity, message }) },
  });
  return { decoder, notes };
}

// ---------------------------------------------------------------------------
// The template, generated
// ---------------------------------------------------------------------------

function rc4(data: string, key: string): string {
  const s: number[] = [];
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key.charCodeAt(i % key.length)) % 256;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  let out = '';
  let x = 0;
  let y = 0;
  for (let i = 0; i < data.length; i++) {
    x = (x + 1) % 256;
    y = (y + s[x]!) % 256;
    [s[x], s[y]] = [s[y]!, s[x]!];
    out += String.fromCharCode(data.charCodeAt(i) ^ s[(s[x]! + s[y]!) % 256]!);
  }
  return out;
}

const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** A string literal spelled the way the 0.x builds spell every literal: hex escapes throughout. */
const escaped = (text: string): string => `'${[...text].map((ch) => (ch.charCodeAt(0) < 256 ? `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}` : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)).join('')}'`;
const plain = (text: string): string => JSON.stringify(text);

interface Template {
  table: string;
  decoder: string;
  encoding: 'base64' | 'rc4';
  key?: string;
  /** Shifts the rotation makes, or none when there is no rotation IIFE. */
  rotation?: number;
  /** `c(++b)` in the IIFE, or the cookie machinery around it. */
  cookie?: boolean;
  /** `c(b)` in place of `c(++b)`: one fewer shift than the literal. */
  plainCount?: boolean;
  stateObject?: boolean;
  /** A state-object pattern that cannot match the compact print: the program never returns from the decoder. */
  brokenStateObject?: boolean;
  idiom?: string;
  fallback?: string;
  polyfill?: 'or' | 'if' | 'assign';
  spell?: (text: string) => string;
  strings: string[];
}

function legacyBuild(options: Template): { source: string; roots: string[] } {
  const spell = options.spell ?? escaped;
  const T = options.table;
  const D = options.decoder;
  const key = options.key ?? 'k3y';
  const encode = (text: string): string =>
    options.encoding === 'base64' ? base64(text) : base64(rc4(text, key));
  const shifts = options.rotation ?? 0;
  // The table as it is rotated at load: `shifts` left-rotations undone.
  const encoded = options.strings.map(encode);
  const stored = shifts === 0 ? encoded : [...encoded.slice(encoded.length - (shifts % encoded.length)), ...encoded.slice(0, encoded.length - (shifts % encoded.length))];
  const idiom = options.idiom ?? "Function('return\\x20(function()\\x20'+'{}.constructor(\\x22return\\x20this\\x22)(\\x20)'+');')()";
  const fallback = options.fallback ?? 'window';
  const polyfillBody = "function(h){var i=String(h)['replace'](/=+$/,'');var j='';for(var k=0x0,l,m,n=0x0;m=i['charAt'](n++);~m&&(l=k%0x4?l*0x40+m:m,k++%0x4)?j+=String['fromCharCode'](0xff&l>>(-0x2*k&0x6)):0x0){m=g['indexOf'](m);}return j;}";
  const polyfill =
    options.polyfill === 'if'
      ? `if(!f['atob']){f['atob']=${polyfillBody};}`
      : options.polyfill === 'assign'
        ? `f['atob']=f['atob']||${polyfillBody};`
        : `f['atob']||(f['atob']=${polyfillBody});`;
  const prologue = `(function(){var e=function(){var h;try{h=${idiom};}catch(i){h=${fallback};}return h;};var f=e();var g='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';${polyfill}}());`;
  const transform =
    options.encoding === 'base64'
      ? `${D}['iYlyGP']=function(e){var f=atob(e);var g=[];for(var h=0x0,j=f['length'];h<j;h++){g+='%'+('00'+f['charCodeAt'](h)['toString'](0x10))['slice'](-0x2);}return decodeURIComponent(g);};`
      : `var x=function(e,k){var s=[],j=0x0,t,r='',p='';e=atob(e);for(var h=0x0,n=e['length'];h<n;h++){p+='%'+('00'+e['charCodeAt'](h)['toString'](0x10))['slice'](-0x2);}e=decodeURIComponent(p);var i;for(i=0x0;i<0x100;i++){s[i]=i;}for(i=0x0;i<0x100;i++){j=(j+s[i]+k['charCodeAt'](i%k['length']))%0x100;t=s[i];s[i]=s[j];s[j]=t;}i=0x0;j=0x0;for(var m=0x0;m<e['length'];m++){i=(i+0x1)%0x100;j=(j+s[i])%0x100;t=s[i];s[i]=s[j];s[j]=t;r+=String['fromCharCode'](e['charCodeAt'](m)^s[(s[i]+s[j])%0x100]);}return r;};${D}['iYlyGP']=x;`;
  const pattern = options.brokenStateObject ? ["'\\x5cw+\\x20*\\x5c(\\x5c)\\x20*{\\x0a\\x5cw+\\x20*'", "'[\\x27|\\x22].+[\\x27|\\x22];?\\x20*}'"] : ["'\\x5cw+\\x20*\\x5c(\\x5c)\\x20*{\\x5cw+\\x20*'", "'[\\x27|\\x22].+[\\x27|\\x22];?\\x20*}'"];
  const stateObject =
    options.stateObject || options.brokenStateObject
      ? `var e=function(f){this['WiEbYW']=f;this['zUfMuq']=[0x1,0x0,0x0];this['miGuCC']=function(){return'newState';};this['vAnxFE']=${pattern[0]};this['UKswlE']=${pattern[1]};};` +
        `e['prototype']['pBEQGN']=function(){var f=new RegExp(this['vAnxFE']+this['UKswlE']);var g=f['test'](this['miGuCC']['toString']())?--this['zUfMuq'][0x1]:--this['zUfMuq'][0x0];return this['zezjpi'](g);};` +
        `e['prototype']['zezjpi']=function(f){if(!Boolean(~f)){return f;}return this['dqknWq'](this['WiEbYW']);};` +
        `e['prototype']['dqknWq']=function(f){for(var g=0x0,h=this['zUfMuq']['length'];g<h;g++){this['zUfMuq']['push'](Math['round'](Math['random']()));h=this['zUfMuq']['length'];}return f(this['zUfMuq'][0x0]);};` +
        `new e(${D})['pBEQGN']();`
      : '';
  const call = options.encoding === 'base64' ? `${D}['iYlyGP'](c)` : `${D}['iYlyGP'](c,b)`;
  const decoder =
    `var ${D}=function(a,b){a=a-0x0;var c=${T}[a];if(${D}['ZICOwj']===undefined){${prologue}${transform}${D}['SUNniA']={};${D}['ZICOwj']=!![];}` +
    `var d=${D}['SUNniA'][a];if(d===undefined){${stateObject}c=${call};${D}['SUNniA'][a]=c;}else{c=d;}return c;};`;
  const literal = options.plainCount ? shifts + 1 : shifts;
  const enter = options.plainCount ? 'c(b);' : 'c(++b);';
  const cookie =
    "var d=function(){var e={'data':{'key':'cookie','value':'timeout'},'setCookie':function(j,k,n,o){o=o||{};var p=k+'='+n;var q=0x0;for(var r=0x0,s=j['length'];r<s;r++){var t=j[r];p+=';\\x20'+t;var u=j[t];j['push'](u);s=j['length'];if(u!==!![]){p+='='+u;}}o['cookie']=p;},'removeCookie':function(){return'dev';},'getCookie':function(i,j){i=i||function(o){return o;};var k=i(new RegExp('(?:^|;\\x20)'+j['replace'](/([.$?*|{}()[]\\/+^])/g,'$1')+'=([^;]*)'));var n=function(o,p){o(++p);};n(c,b);return k?decodeURIComponent(k[0x1]):undefined;}};" +
    "var f=function(){var i=new RegExp('\\x5cw+\\x20*\\x5c(\\x5c)\\x20*{\\x5cw+\\x20*[\\x27|\\x22].+[\\x27|\\x22];?\\x20*}');return i['test'](e['removeCookie']['toString']());};e['updateCookie']=f;var g='';var h=e['updateCookie']();if(!h){e['setCookie'](['*'],'counter',0x1);}else if(h){g=e['getCookie'](null,'counter');}else{e['removeCookie']();}};d();";
  const rotation =
    options.rotation === undefined
      ? ''
      : `(function(a,b){var c=function(e){while(--e){a['push'](a['shift']());}};${options.cookie ? cookie : enter}}(${T},0x${literal.toString(16)}));`;
  const table = `var ${T}=[${stored.map(spell).join(',')}];`;
  const args = options.strings.map((_, index) => (options.encoding === 'base64' ? `${D}(${spell(`0x${index.toString(16)}`)})` : `${D}(${spell(`0x${index.toString(16)}`)},${spell(key)})`));
  const program = `log(${args.join(',')});`;
  return { source: table + rotation + decoder + program, roots: [D, T] };
}

const STRINGS = ['chain', 'debu', 'gger', 'constructor', 'ünïcödé ✓', 'while (true) {}', 'return /" + this + "/', 'apply', 'test', 'a%20b'];

interface Variant {
  name: string;
  template: Template;
  /** The native tier reads the shape; the interpreter confirms it. */
  native: RegExp;
}

const VARIANTS: Variant[] = [
  {
    name: 'base64, direct rotation, hex-escaped literals',
    template: { table: '_ya', decoder: '_yb', encoding: 'base64', rotation: 0x10a % STRINGS.length, strings: STRINGS },
    native: /^base64 \(standard alphabet, utf8\), rotation \d+$/,
  },
  {
    name: 'base64, cookie machinery, state object: the obfuscator.io selfDefending build',
    template: { table: '_ya', decoder: '_yb', encoding: 'base64', rotation: 7, cookie: true, stateObject: true, strings: STRINGS },
    native: /^base64 \(standard alphabet, utf8\), rotation 7$/,
  },
  {
    name: 'rc4, direct rotation: the ds.js build',
    template: { table: '_0x3378', decoder: '_0x2cb1', encoding: 'rc4', key: 'b^O&', rotation: 4, strings: STRINGS },
    native: /^rc4 \(256-entry KSA\/PRGA over base64\), rotation 4$/,
  },
  {
    name: 'rc4, cookie machinery, state object',
    template: { table: '_0x3378', decoder: '_0x2cb1', encoding: 'rc4', key: 'G&ow', rotation: 9, cookie: true, stateObject: true, strings: STRINGS },
    native: /^rc4 \(256-entry KSA\/PRGA over base64\), rotation 9$/,
  },
  {
    name: 'base64, rotation entered with c(b)',
    template: { table: 'T', decoder: 'D', encoding: 'base64', rotation: 3, plainCount: true, strings: STRINGS, spell: plain },
    native: /rotation 3$/,
  },
  {
    name: 'base64, if-polyfill, indirect eval idiom, globalThis fallback',
    template: { table: 'T', decoder: 'D', encoding: 'base64', rotation: 2, polyfill: 'if', idiom: "(0,eval)('this')", fallback: 'globalThis', strings: STRINGS },
    native: /rotation 2$/,
  },
  {
    name: 'base64, assigned polyfill, new Function idiom, self fallback',
    template: { table: 'T', decoder: 'D', encoding: 'base64', rotation: 5, polyfill: 'assign', idiom: "new Function('return this')()", fallback: 'self', strings: STRINGS },
    native: /rotation 5$/,
  },
  {
    name: 'base64, the constructor spelling of the idiom in the tree',
    template: { table: 'T', decoder: 'D', encoding: 'base64', rotation: 1, idiom: "(function(){}).constructor('return this')()", strings: STRINGS },
    native: /rotation 1$/,
  },
  {
    name: 'rc4, other names, plain literals, no rotation',
    template: { table: 'strings', decoder: 'decode', encoding: 'rc4', key: '#0BZ', strings: STRINGS, spell: plain },
    native: /^rc4 \(256-entry KSA\/PRGA over base64\)$/,
  },
  {
    name: 'base64, no rotation, state object',
    template: { table: '_0xabc', decoder: '_0xdef', encoding: 'base64', stateObject: true, strings: STRINGS },
    native: /^base64 \(standard alphabet, utf8\)$/,
  },
];

describe('the obfuscator.io 0.x template', () => {
  for (const variant of VARIANTS) {
    it(`decodes and prunes: ${variant.name}`, async () => {
      const { source, roots } = legacyBuild(variant.template);
      const expected = execute(source);
      expect(expected).not.toMatch(/THROWN/);
      expect(expected).toContain('"ünïcödé ✓"');

      const native = recogniseNativeDecoder(sliceForEvaluation(programPath(source), roots), roots);
      expect(native?.evidence, 'the native tier reads the shape').toMatch(variant.native);

      for (const preset of PRESETS) {
        const { decoder, notes } = build(source, roots, preset);
        expect(decoder, `${preset}: ${notes.map((n) => n.message).join('\n')}`).toBeDefined();
        expect(decoder!.tier).toBe('native');
        expect(notes.filter((n) => n.severity === 'error')).toEqual([]);

        const result = await deobfuscate(source, { preset });
        expect(execute(result.code), preset).toBe(expected);
        expect(result.metadata.strings.length, preset).toBeGreaterThanOrEqual(STRINGS.length);
        // Every call site inlined, the decoder and its table gone with them.
        expect(result.code).not.toMatch(new RegExp(`\\b${variant.template.decoder}\\(`));
        expect(result.code).not.toContain(variant.template.table);
        expect(result.code).toContain('ünïcödé ✓');
        expect(result.code).not.toMatch(/Function\(|atob\(/);
      }
    });
  }

  it('refuses a state object whose pattern cannot match the compact print, where the program never returns', () => {
    const { source, roots } = legacyBuild({ table: 'T', decoder: 'D', encoding: 'base64', rotation: 2, brokenStateObject: true, strings: STRINGS });
    expect(findStateObjectGuards(programPath(source).node.body)).toEqual([]);
    for (const preset of PRESETS) {
      const { decoder, notes } = build(source, roots, preset);
      expect(decoder, preset).toBeUndefined();
      expect(notes.some((n) => /ran out of budget|hit a limit|Refusing/.test(n.message)), notes.map((n) => n.message).join('\n')).toBe(true);
    }
  });

  it('reads the state object, the prologue and the fixed rotation as shapes', () => {
    const { source } = legacyBuild({ table: '_ya', decoder: '_yb', encoding: 'base64', rotation: 7, cookie: true, stateObject: true, strings: STRINGS });
    const program = programPath(source).node.body;
    const guards = findStateObjectGuards(program);
    expect(guards).toHaveLength(1);
    expect(guards[0]!.definitions).toHaveLength(4);
    const decoder = program.find((s): s is t.VariableDeclaration => s.type === 'VariableDeclaration' && (s.declarations[0]!.id as t.Identifier).name === '_yb')!;
    const fn = decoder.declarations[0]!.init as t.FunctionExpression;
    expect(findGlobalObjectPrologue(fn)).toBeDefined();
    const rotation = recogniseFixedRotation(program, '_ya');
    expect(rotation?.shifts).toBe(7);

    const statements = [...program];
    const excised = exciseStateObjectGuards(statements);
    expect(excised).toHaveLength(1);
    expect(findStateObjectGuards(statements)).toEqual([]);

    // The same guard at the top of a list is cut from that list.
    const top = [...guards[0]!.definitions, guards[0]!.invocation, ...program];
    expect(exciseStateObjectGuards(top)).toHaveLength(1);
    expect(top).not.toContain(guards[0]!.invocation);
    expect(top).toHaveLength(guards[0]!.definitions.length + program.length);
  });

  it('reads no rotation from a shuffle entered with a count that never ends', () => {
    const { source } = legacyBuild({ table: 'T', decoder: 'D', encoding: 'base64', rotation: 0, plainCount: true, strings: STRINGS });
    // `c(b)` over `0x0`: `while (--e)` never reaches zero; the shape is refused, not read as no rotation.
    const program = programPath(source.replace('(T,0x1)', '(T,0x0)')).node.body;
    expect(recogniseFixedRotation(program, 'T')).toBeNull();
  });

  it('refuses the idiom itself as a decoder: a Function over any other source is not run', () => {
    const source = "var T = ['YQ=='];\nfunction D(i) { var g = Function('return atob')(); return g(T[i]); }\nlog(D(0));";
    for (const preset of PRESETS) {
      const { decoder, notes } = build(source, ['D', 'T'], preset);
      expect(decoder, preset).toBeUndefined();
      expect(notes.map((n) => n.message).join('\n')).toMatch(/Function constructor compiles source the interpreter does not run|outside the evaluation allowlist|interpreter rejected/);
    }
  });
});
