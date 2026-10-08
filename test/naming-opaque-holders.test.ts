import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renameIdentifiersPass as pass } from '../src/passes/rename/identifiers.js';
import type { DeobfuscateOptions } from '../src/types.js';
import { runPass } from './helpers.js';

/**
 * A computed key nothing resolves - `v[globalThis.KEY]`, `v[dec(i) + 'e']`
 * with the decoder refused - read on a parameter is read as `.name`, since
 * the key may be exactly that, and the read resolves to what the callers
 * pass. It did so for a plain direct call and for nothing else: the same
 * read inside a block-level function in sloppy code, a method of a local
 * literal or one assigned to it, a program-scope function called through a
 * string key on the global object, or a class constructor renamed the
 * argument's function with no word said - four obfuscation-introduced
 * divergences of the round-eleven fuzz, reduced to one mechanism. The
 * callers of each are now enumerated: the references of the name a block
 * function is called by past its block, the `o.k(...)` sites of the local
 * that holds a method, every read of the key through a spelling of the
 * global object and every `g[k](...)` with `k` undecoded, the `new C(...)`
 * sites of a class. Whatever function an argument reaches, the read on
 * its parameter reads the argument.
 *
 * Every case runs input and output in a vm with only `log`, at all three
 * presets, and compares what they print; the four obfuscated inputs are run
 * against what their sources print.
 */

const PRESETS: DeobfuscateOptions[] = [
  { preset: 'conservative' },
  { preset: 'balanced' },
  { preset: 'aggressive' },
];

function observe(code: string): string[] {
  const logs: string[] = [];
  const context = vm.createContext({ log: (...values: unknown[]) => logs.push(values.map(String).join(' ')) });
  vm.runInContext(code, context, { timeout: 5_000 });
  return logs;
}

/** Input and output print the same thing at every preset; returns the aggressive output. */
async function expectPreserved(source: string, expected: string[]): Promise<string> {
  expect(observe(source)).toEqual(expected);
  let aggressive = '';
  for (const options of PRESETS) {
    const { code } = await runPass(pass, source, options);
    expect(observe(code), options.preset).toEqual(expected);
    if (options.preset === 'aggressive') aggressive = code;
  }
  return aggressive;
}

const KEY = `globalThis.KEY = 'name';`;
const FN = `function _0x96d6() {}`;

describe('an unresolved key read on a parameter reads the argument, whatever the function is', () => {
  it('a plain direct call, the control', async () => {
    const code = await expectPreserved(`function _0xc(v) { return 'fn:' + v[globalThis.KEY]; } ${KEY} log(_0xc(${FN}));`, ['fn:_0x96d6']);
    expect(code).toContain('function _0x96d6');
  });

  it('a block-level function in sloppy code, called past its block', async () => {
    // Babel scopes the declaration to the block, and the call after the
    // loop resolves to nothing; every reference of the name in the var
    // scope is a caller. Before: aggressive printed `fn:val1`.
    for (const loop of ['for (var i = 0; i < 1; i++)', 'var n = 0; while (n++ < 1)', 'if (true)']) {
      const code = await expectPreserved(
        `${loop} { function _0xc(v) { return 'fn:' + v[globalThis.KEY]; } } ${KEY} log(_0xc(${FN}));`,
        ['fn:_0x96d6'],
      );
      expect(code, loop).toContain('function _0x96d6');
    }
  });

  it('a block-level function whose key comes from a refused two-reader table', async () => {
    const code = await expectPreserved(
      `
        function _0xt() { var o = ['name']; _0xt = function () { return o; }; return _0xt(); }
        function _0xd(i) { return _0xt()[i]; }
        function _0xp(i) { return _0xt()[i]; }
        for (var i = 0; i < 1; i++) { function _0xc(v) { return 'fn:' + v[_0xd(0)]; } }
        log(_0xc(${FN}));
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('a method of a local literal, and one assigned to a local', async () => {
    for (const method of [
      `var o = { m: function (v) { return 'fn:' + v[globalThis.KEY]; } };`,
      `var o = { m(v) { return 'fn:' + v[globalThis.KEY]; } };`,
      `var o = {}; o.m = function (v) { return 'fn:' + v[globalThis.KEY]; };`,
      `var o = {}; o.m = function (v) { var w = v; return 'fn:' + w[globalThis.KEY]; };`,
    ]) {
      const code = await expectPreserved(`${method} ${KEY} log(o.m(${FN}));`, ['fn:_0x96d6']);
      expect(code, method).toContain('function _0x96d6');
    }
  });

  it('a program-scope function called through a string key on the global object, or an alias of it', async () => {
    for (const call of [`log(globalThis['_0xf'](${FN}));`, `var g = globalThis; log(g['_0xf'](${FN}));`]) {
      const code = await expectPreserved(`function _0xf(v) { return 'fn:' + v[globalThis.KEY]; } ${KEY} ${call}`, ['fn:_0x96d6']);
      expect(code, call).toContain('function _0x96d6');
    }
  });

  it('a program-scope function called through a key on the global object nothing resolves', async () => {
    // `g[k](fn)` with `k` undecoded may call any program-scope function, so
    // it is a caller of every one of them.
    const code = await expectPreserved(
      `
        function _0xf(v) { return 'fn:' + v[globalThis.KEY]; }
        ${KEY}
        var g = globalThis;
        var k = ['_0xf'].join('');
        log(g[k](${FN}));
      `,
      ['fn:_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('a class constructor', async () => {
    const code = await expectPreserved(
      `class C { constructor(v) { this.n = v[globalThis.KEY]; } } ${KEY} log(new C(${FN}).n);`,
      ['_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });

  it('an instance method, through an instance a local holds and through this', async () => {
    for (const call of [
      `var c = new C(); log(c.m(${FN}));`,
      `log(new C().m(${FN}));`,
      `class D { run() { return this.m(${FN}); } m(v) { return 'fn:' + v[globalThis.KEY]; } } log(new D().run());`,
    ]) {
      const code = await expectPreserved(`class C { m(v) { return 'fn:' + v[globalThis.KEY]; } } ${KEY} ${call}`, ['fn:_0x96d6']);
      expect(code, call).toContain('function _0x96d6');
    }
  });

  it('a class expression held by a local, and a static method', async () => {
    let code = await expectPreserved(
      `var C = class { constructor(v) { this.n = v[globalThis.KEY]; } }; ${KEY} log(new C(${FN}).n);`,
      ['_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
    code = await expectPreserved(
      `class C { static m(v) { return v[globalThis.KEY]; } } ${KEY} log(C.m(${FN}));`,
      ['_0x96d6'],
    );
    expect(code).toContain('function _0x96d6');
  });
});

describe('the four round-eleven trials, obfuscated input against source', () => {
  it('trial 1525', async () => {
    const source = String.raw`for (var i = 0; i < 1; i++) {
  function _0xc(v) { var n = v.name; return 'fn:' + n; }
}
log(_0xc(function _0x96d6() {}));`;
    const obfuscated = String.raw`function _0x4b69(_0x1f99f1,_0xfbb535){_0x1f99f1=_0x1f99f1-0x83;var _0x129f1b=_0xfbb5();var _0x55c8ce=_0x129f1b[_0x1f99f1];if(_0x4b69['gXUEVo']===undefined){var _0x40fe2d=function(_0x4bd956){var _0x50feee='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';var _0x4b69b8='';var _0x1fc034='';for(var _0x37ea06=0x0,_0x1084e0,_0x5ee74b,_0x8267fb=0x0;_0x5ee74b=_0x4bd956['charAt'](_0x8267fb++);~_0x5ee74b&&(_0x1084e0=_0x37ea06%0x4?_0x1084e0*0x40+_0x5ee74b:_0x5ee74b,_0x37ea06++%0x4)?_0x4b69b8+=String['fromCharCode'](0xff&_0x1084e0>>(-0x2*_0x37ea06&0x6)):0x0){_0x5ee74b=_0x50feee['indexOf'](_0x5ee74b);}for(var _0x3202a9=0x0,_0x51625a=_0x4b69b8['length'];_0x3202a9<_0x51625a;_0x3202a9++){_0x1fc034+='%'+('00'+_0x4b69b8['charCodeAt'](_0x3202a9)['toString'](0x10))['slice'](-0x2);}return decodeURIComponent(_0x1fc034);};_0x4b69['ZpxoHR']=_0x40fe2d;_0x4b69['OSsaQu']={};_0x4b69['gXUEVo']=!![];}var _0x2aa588=_0x129f1b[0x0];if(_0x4b69['pdIMry']!==_0x2aa588){_0x4b69['OSsaQu']={};_0x4b69['pdIMry']=_0x2aa588;}var _0x2bec17=_0x4b69['OSsaQu'][_0x1f99f1];if(_0x2bec17===undefined){_0x55c8ce=_0x4b69['ZpxoHR'](_0x55c8ce);_0x4b69['OSsaQu'][_0x1f99f1]=_0x55c8ce;}else{_0x55c8ce=_0x2bec17;}return _0x55c8ce;}function _0xfbb5(){var _0x2fbf0a=['BMfT','zM46'];_0xfbb5=function(){return _0x2fbf0a;};return _0xfbb5();}for(var i=0x0;i<0x1;i++){function _0xc(_0x48ace0){var _0x90e8c={_0x5ee839:'0x83',_0x139e94:'0x84'};var _0x2410a0=_0x48ace0[_0x4b69(_0x90e8c._0x5ee839)+'e'];return _0x4b69(_0x90e8c._0x139e94)+_0x2410a0;}}function _0x129f(_0x1f99f1,_0xfbb535){_0x1f99f1=_0x1f99f1-0x83;var _0x129f1b=_0xfbb5();var _0x55c8ce=_0x129f1b[_0x1f99f1];return _0x55c8ce;}log(_0xc(function _0x96d6(){}));`;
    const expected = observe(source);
    expect(observe(obfuscated)).toEqual(expected);
    for (const options of PRESETS) {
      const { code } = await runPass(pass, obfuscated, options);
      expect(observe(code), options.preset).toEqual(expected);
    }
  });

  it('trial 1837', async () => {
    const source = String.raw`var o = { m: function (v) { return 'fn:' + v.name; } };
log(o.m(function _0x96d6() {}));`;
    const obfuscated = String.raw`function b(c,d){c=c-(0x1*-0x9c5+-0x58b+0xf5*0x10);var e=a();var f=e[c];if(b['mVTFuW']===undefined){var g=function(l){var m='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';var n='';var o='';for(var p=-0x13*0x101+-0x254d*0x1+-0x3860*-0x1,q,r,s=-0xc85+-0x7*-0x238+-0x303;r=l['charAt'](s++);~r&&(q=p%(-0x7*-0x38b+-0x1112*-0x1+-0x29db)?q*(-0xe0f+-0x31*0x37+0x18d6)+r:r,p++%(-0x46d+-0x25cc+-0x1*-0x2a3d))?n+=String['fromCharCode'](-0x1ed6+-0x96e+0x15*0x1f7&q>>(-(0x930+-0x716*0x4+-0x1*-0x132a)*p&-0x964+0x1a+0x8*0x12a)):-0xc*-0x104+-0xc61+0x31){r=m['indexOf'](r);}for(var t=0x19c4+0x3*-0x2d+-0x193d,u=n['length'];t<u;t++){o+='%'+('00'+n['charCodeAt'](t)['toString'](0x4*0x887+0x1517+-0x3723))['slice'](-(0x39*-0x52+-0x25cc+-0x30*-0x12b));}return decodeURIComponent(o);};var j=function(k,l){var m=[],n=0x85*-0xb+-0xa6a+0x1021,o,p='';k=g(k);var q;for(q=0x67*-0x59+-0xb*-0x76+0x1ebd;q<-0xb9*0x2e+-0x1208*-0x1+0x1036;q++){m[q]=q;}for(q=-0x1*-0x1ee4+-0x1d6c+-0x178;q<-0x1549+0x1fe1*0x1+0x4cc*-0x2;q++){n=(n+m[q]+l['charCodeAt'](q%l['length']))%(0x222a+-0x5*0x5ad+-0x31*0x19);o=m[q];m[q]=m[n];m[n]=o;}q=-0x1*-0x74+0x2*-0x12dc+0x109*0x24;n=0x20a5+0xd8e+-0x2e33;for(var r=0x56f+0xd9e+-0x1*0x130d;r<k['length'];r++){q=(q+(0x2c8*-0xe+-0x4*0x505+0x1d*0x209))%(0x1d4+-0x239*0x2+-0x39e*-0x1);n=(n+m[q])%(-0x7*-0x13+-0x42d+0x95*0x8);o=m[q];m[q]=m[n];m[n]=o;p+=String['fromCharCode'](k['charCodeAt'](r)^m[(m[q]+m[n])%(0xe*0xfe+-0x1*0x211f+0x143b)]);}return p;};b['MBxeOl']=j;b['QaAxBn']={};b['mVTFuW']=!![];}var h=e[0x107f+0x9f4+0x8d1*-0x3];if(b['JUwpKG']!==h){b['QaAxBn']={};b['JUwpKG']=h;}var i=b['QaAxBn'][c];if(i===undefined){if(b['iQPJdL']===undefined){b['iQPJdL']=!![];}f=b['MBxeOl'](f,d);b['QaAxBn'][c]=f;}else{f=i;}return f;}function c(b,d){b=b-(0x1*-0x9c5+-0x58b+0xf5*0x10);var e=a();var f=e[b];if(c['eAKRXO']===undefined){var g=function(j){var l='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';var m='';var n='';for(var o=-0x13*0x101+-0x254d*0x1+-0x3860*-0x1,p,q,r=-0xc85+-0x7*-0x238+-0x303;q=j['charAt'](r++);~q&&(p=o%(-0x7*-0x38b+-0x1112*-0x1+-0x29db)?p*(-0xe0f+-0x31*0x37+0x18d6)+q:q,o++%(-0x46d+-0x25cc+-0x1*-0x2a3d))?m+=String['fromCharCode'](-0x1ed6+-0x96e+0x15*0x1f7&p>>(-(0x930+-0x716*0x4+-0x1*-0x132a)*o&-0x964+0x1a+0x8*0x12a)):-0xc*-0x104+-0xc61+0x31){q=l['indexOf'](q);}for(var s=0x19c4+0x3*-0x2d+-0x193d,t=m['length'];s<t;s++){n+='%'+('00'+m['charCodeAt'](s)['toString'](0x4*0x887+0x1517+-0x3723))['slice'](-(0x39*-0x52+-0x25cc+-0x30*-0x12b));}return decodeURIComponent(n);};c['hxirBh']=g;c['zpJXGy']={};c['eAKRXO']=!![];}var h=e[0x85*-0xb+-0xa6a+0x1021];if(c['FsYIFy']!==h){c['zpJXGy']={};c['FsYIFy']=h;}var i=c['zpJXGy'][b];if(i===undefined){f=c['hxirBh'](f);c['zpJXGy'][b]=f;}else{f=i;}return f;}var o={'m':function(d){function f(d,g,h,i){return b(d- -0x71,h);}function e(d,g,h,i){return c(d- -0xf8,i);}return e(-0xf7,-0xf8,-0xf8,-0xf8)+d[f(-0x71,-0x71,']GB@',-0x70)];}};log(o['m'](function _0x96d6(){}));function a(){var j=['WRFdVSoyqW','zM46'];a=function(){return j;};return a();}`;
    const expected = observe(source);
    expect(observe(obfuscated)).toEqual(expected);
    for (const options of PRESETS) {
      const { code } = await runPass(pass, obfuscated, options);
      expect(observe(code), options.preset).toEqual(expected);
    }
  });

  it('trial 9124', async () => {
    const source = String.raw`var o = {};
o.m = function (v) { var w = v; log(w.name); };
o.m(function _0xffff() {});`;
    const obfuscated = String.raw`function _0x22dd() {
    var _0x3b5713 = ['\x42\x4d\x66\x54'];
    _0x22dd = function () {
        return _0x3b5713;
    };
    return _0x22dd();
}
var o = {};
function _0x4f13(_0x297208, _0x22dd24) {
    _0x297208 = _0x297208 - 0x80;
    var _0x4f1395 = _0x22dd();
    var _0x18d3b6 = _0x4f1395[_0x297208];
    if (_0x4f13['\x4e\x6a\x49\x42\x49\x7a'] === undefined) {
        var _0x56f191 = function (_0x2a9e71) {
            var _0x3aedfe = '\x61\x62\x63\x64\x65\x66\x67\x68\x69\x6a\x6b\x6c\x6d\x6e\x6f\x70\x71\x72\x73\x74\x75\x76\x77\x78\x79\x7a\x41\x42\x43\x44\x45\x46\x47\x48\x49\x4a\x4b\x4c\x4d\x4e\x4f\x50\x51\x52\x53\x54\x55\x56\x57\x58\x59\x5a\x30\x31\x32\x33\x34\x35\x36\x37\x38\x39\x2b\x2f\x3d';
            var _0xdfad3e = '', _0x4ccfa5 = '';
            for (var _0x4bf8df = 0x0, _0x77ab57, _0x2cb5d0, _0x3bf888 = 0x0; _0x2cb5d0 = _0x2a9e71['\x63\x68\x61\x72\x41\x74'](_0x3bf888++); ~_0x2cb5d0 && (_0x77ab57 = _0x4bf8df % 0x4 ? _0x77ab57 * 0x40 + _0x2cb5d0 : _0x2cb5d0, _0x4bf8df++ % 0x4) ? _0xdfad3e += String['\x66\x72\x6f\x6d\x43\x68\x61\x72\x43\x6f\x64\x65'](0xff & _0x77ab57 >> (-0x2 * _0x4bf8df & 0x6)) : 0x0) {
                _0x2cb5d0 = _0x3aedfe['\x69\x6e\x64\x65\x78\x4f\x66'](_0x2cb5d0);
            }
            for (var _0x2b28f3 = 0x0, _0x2a1962 = _0xdfad3e['\x6c\x65\x6e\x67\x74\x68']; _0x2b28f3 < _0x2a1962; _0x2b28f3++) {
                _0x4ccfa5 += '\x25' + ('\x30\x30' + _0xdfad3e['\x63\x68\x61\x72\x43\x6f\x64\x65\x41\x74'](_0x2b28f3)['\x74\x6f\x53\x74\x72\x69\x6e\x67'](0x10))['\x73\x6c\x69\x63\x65'](-0x2);
            }
            return decodeURIComponent(_0x4ccfa5);
        };
        _0x4f13['\x56\x4f\x6e\x62\x56\x61'] = _0x56f191, _0x4f13['\x77\x74\x45\x67\x6a\x48'] = {}, _0x4f13['\x4e\x6a\x49\x42\x49\x7a'] = !![];
    }
    var _0x16149b = _0x4f1395[0x0];
    _0x4f13['\x64\x50\x66\x67\x6d\x61'] !== _0x16149b && (_0x4f13['\x77\x74\x45\x67\x6a\x48'] = {}, _0x4f13['\x64\x50\x66\x67\x6d\x61'] = _0x16149b);
    var _0x4e48bd = _0x4f13['\x77\x74\x45\x67\x6a\x48'][_0x297208];
    return _0x4e48bd === undefined ? (_0x18d3b6 = _0x4f13['\x56\x4f\x6e\x62\x56\x61'](_0x18d3b6), _0x4f13['\x77\x74\x45\x67\x6a\x48'][_0x297208] = _0x18d3b6) : _0x18d3b6 = _0x4e48bd, _0x18d3b6;
}
o['\x6d'] = function (_0x115949) {
    var _0x22070b = { _0x50e218: 0x80 }, _0x2a7f1a = {
            '\x64\x51\x50\x74\x51': function (_0xe70a4a, _0x178541) {
                return _0xe70a4a(_0x178541);
            }
        }, _0x6a00bf = _0x115949;
    _0x2a7f1a['\x64\x51\x50' + '\x74\x51'](log, _0x6a00bf[_0x4f13(_0x22070b._0x50e218) + '\x65']);
}, o['\x6d'](function _0xffff() {
});`;
    const expected = observe(source);
    expect(observe(obfuscated)).toEqual(expected);
    for (const options of PRESETS) {
      const { code } = await runPass(pass, obfuscated, options);
      expect(observe(code), options.preset).toEqual(expected);
    }
  });

  it('trial 9561', async () => {
    const source = String.raw`function _0xf(v) { return 'fn:' + v.name; }
var g = globalThis;
log(g['_0xf'](function _0x96d6() {}));`;
    const obfuscated = String.raw`(function(i,V){var b=o,W=i();while(!![]){try{var S=parseInt(b(0x1e6))/0x1*(parseInt(b(0x1e9))/0x2)+parseInt(b(0x1e1))/0x3+parseInt(b(0x1df))/0x4+-parseInt(b(0x1e5))/0x5*(-parseInt(b(0x1e0))/0x6)+-parseInt(b(0x1e4))/0x7+-parseInt(b(0x1e7))/0x8*(-parseInt(b(0x1e3))/0x9)+-parseInt(b(0x1e2))/0xa*(parseInt(b(0x1e8))/0xb);if(S===V)break;else W['push'](W['shift']());}catch(h){W['push'](W['shift']());}}}(Z,0xe24d0));function o(i,V){i=i-0x1df;var W=Z();var S=W[i];return S;}var _0x4c0b4d=_0x1482;(function(i,V){var W=_0x1482,S=_0x1482,h=i();while(!![]){try{if('\x75\x4c'+'\x6b\x66'+'\x53'==='\x75\x4c'+'\x6b\x66'+'\x53'){var N=-parseInt(W('\x30\x78'+'\x35'))/0x1+parseInt(W('\x30\x78'+'\x36'))/0x2*(-parseInt(S('\x30\x78'+'\x32'))/0x3)+parseInt(S('\x30\x78'+'\x33'))/0x4+-parseInt(W('\x30\x78'+'\x34'))/0x5*(-parseInt(W('\x30\x78'+'\x30'))/0x6)+-parseInt(S('\x30\x78'+'\x39'))/0x7+-parseInt(W('\x30\x78'+'\x64'))/0x8*(parseInt(W('\x30\x78'+'\x37'))/0x9)+parseInt(W('\x30\x78'+'\x62'))/0xa;if(N===V){if('\x69\x66'+'\x45\x5a'+'\x79'==='\x58\x5a'+'\x74\x72'+'\x50')return V;else break;}else h['\x70\x75'+'\x73\x68'](h['\x73\x68'+'\x69\x66'+'\x74']());}else S=h['\x69\x6e'+'\x64\x65'+'\x78\x4f'+'\x66'](N);}catch(H){if('\x56\x52'+'\x70\x48'+'\x63'!=='\x51\x4a'+'\x4b\x6f'+'\x74')h['\x70\x75'+'\x73\x68'](h['\x73\x68'+'\x69\x66'+'\x74']());else{var m=function(a){var G='\x61\x62'+'\x63\x64'+'\x65\x66'+'\x67\x68'+'\x69\x6a'+'\x6b\x6c'+'\x6d\x6e'+'\x6f\x70'+'\x71\x72'+'\x73\x74'+'\x75\x76'+'\x77\x78'+'\x79\x7a'+'\x41\x42'+'\x43\x44'+'\x45\x46'+'\x47\x48'+'\x49\x4a'+'\x4b\x4c'+'\x4d\x4e'+'\x4f\x50'+'\x51\x52'+'\x53\x54'+'\x55\x56'+'\x57\x58'+'\x59\x5a'+'\x30\x31'+'\x32\x33'+'\x34\x35'+'\x36\x37'+'\x38\x39'+'\x2b\x2f'+'\x3d',M='',L='';for(var B=0x0,A,D,v=0x0;D=a['\x63\x68'+'\x61\x72'+'\x41\x74'](v++);~D&&(A=B%0x4?A*0x40+D:D,B++%0x4)?M+=m['\x66\x72'+'\x6f\x6d'+'\x43\x68'+'\x61\x72'+'\x43\x6f'+'\x64\x65'](0xff&A>>(-0x2*B&0x6)):0x0){D=G['\x69\x6e'+'\x64\x65'+'\x78\x4f'+'\x66'](D);}for(var s=0x0,J=M['\x6c\x65'+'\x6e\x67'+'\x74\x68'];s<J;s++){L+='\x25'+('\x30\x30'+M['\x63\x68'+'\x61\x72'+'\x43\x6f'+'\x64\x65'+'\x41\x74'](s)['\x74\x6f'+'\x53\x74'+'\x72\x69'+'\x6e\x67'](0x10))['\x73\x6c'+'\x69\x63'+'\x65'](-0x2);}return z(L);};H['\x4d\x41'+'\x43\x6f'+'\x56\x6c']=m,m['\x77\x7a'+'\x67\x75'+'\x57\x50']={},j['\x56\x61'+'\x6c\x54'+'\x46\x69']=!![];}}}}(_0x547d,0x42f0f));function _0xf(i){var V=_0x1482,W=_0x1482,S={'\x4f\x6f\x79\x56\x58':function(h,N){if('\x57\x43'+'\x69\x48'+'\x68'!=='\x57\x43'+'\x69\x48'+'\x68')S+='\x25'+('\x30\x30'+h['\x63\x68'+'\x61\x72'+'\x43\x6f'+'\x64\x65'+'\x41\x74'](N)['\x74\x6f'+'\x53\x74'+'\x72\x69'+'\x6e\x67'](0x10))['\x73\x6c'+'\x69\x63'+'\x65'](-0x2);else return h+N;}};return S[V('\x30\x78'+'\x61')](W('\x30\x78'+'\x31'),i[V('\x30\x78'+'\x38')]);}function _0x547d(){var i=['\x6e\x5a'+'\x65\x57'+'\x6d\x5a'+'\x65\x57'+'\x71\x30'+'\x72\x70'+'\x73\x77'+'\x54\x4a','\x6f\x64'+'\x6d\x31'+'\x6d\x74'+'\x44\x75'+'\x73\x78'+'\x4c\x49'+'\x77\x66'+'\x61','\x6d\x74'+'\x6a\x58'+'\x45\x4c'+'\x7a\x31'+'\x74\x4e'+'\x65','\x6d\x4a'+'\x44\x4d'+'\x7a\x33'+'\x7a\x50'+'\x73\x4e'+'\x4b','\x42\x4d'+'\x66\x54'+'\x7a\x71','\x6d\x5a'+'\x69\x33'+'\x6e\x64'+'\x65\x35'+'\x6e\x65'+'\x6e\x72'+'\x76\x4d'+'\x6a\x77'+'\x41\x57','\x74\x32'+'\x39\x35'+'\x76\x4c'+'\x47','\x6d\x74'+'\x61\x57'+'\x6f\x64'+'\x4b\x58'+'\x6f\x74'+'\x62\x71'+'\x45\x4d'+'\x6a\x54'+'\x75\x31'+'\x61','\x78\x5a'+'\x62\x34'+'\x7a\x47','\x6e\x5a'+'\x71\x57'+'\x6e\x74'+'\x79\x57'+'\x76\x67'+'\x35\x49'+'\x44\x33'+'\x72\x6b','\x6e\x4b'+'\x35\x56'+'\x71\x4d'+'\x35\x76'+'\x41\x47','\x7a\x4d'+'\x34\x36','\x6d\x4a'+'\x61\x58'+'\x6d\x74'+'\x47\x5a'+'\x76\x30'+'\x31\x75'+'\x43\x4c'+'\x48\x5a','\x6d\x74'+'\x71\x58'+'\x6f\x64'+'\x65\x34'+'\x6d\x68'+'\x44\x75'+'\x74\x77'+'\x4c\x58'+'\x7a\x57'];return _0x547d=function(){return i;},_0x547d();}function _0x1482(i,V){i=i-0x0;var W=_0x547d(),S=W[i];if(_0x1482['\x56\x61'+'\x6c\x54'+'\x46\x69']===undefined){if('\x44\x55'+'\x69\x63'+'\x6a'!=='\x44\x55'+'\x69\x63'+'\x6a')S['\x77\x7a'+'\x67\x75'+'\x57\x50']={},h['\x41\x58'+'\x6d\x73'+'\x49\x53']=N;else{var h=function(m){var j='\x61\x62'+'\x63\x64'+'\x65\x66'+'\x67\x68'+'\x69\x6a'+'\x6b\x6c'+'\x6d\x6e'+'\x6f\x70'+'\x71\x72'+'\x73\x74'+'\x75\x76'+'\x77\x78'+'\x79\x7a'+'\x41\x42'+'\x43\x44'+'\x45\x46'+'\x47\x48'+'\x49\x4a'+'\x4b\x4c'+'\x4d\x4e'+'\x4f\x50'+'\x51\x52'+'\x53\x54'+'\x55\x56'+'\x57\x58'+'\x59\x5a'+'\x30\x31'+'\x32\x33'+'\x34\x35'+'\x36\x37'+'\x38\x39'+'\x2b\x2f'+'\x3d',E='',z='';for(var d=0x0,X,Q,k=0x0;Q=m['\x63\x68'+'\x61\x72'+'\x41\x74'](k++);~Q&&(X=d%0x4?X*0x40+Q:Q,d++%0x4)?E+=String['\x66\x72'+'\x6f\x6d'+'\x43\x68'+'\x61\x72'+'\x43\x6f'+'\x64\x65'](0xff&X>>(-0x2*d&0x6)):0x0){if('\x43\x56'+'\x71\x72'+'\x4a'==='\x43\x56'+'\x71\x72'+'\x4a')Q=j['\x69\x6e'+'\x64\x65'+'\x78\x4f'+'\x66'](Q);else return W+S;}for(var f=0x0,I=E['\x6c\x65'+'\x6e\x67'+'\x74\x68'];f<I;f++){z+='\x25'+('\x30\x30'+E['\x63\x68'+'\x61\x72'+'\x43\x6f'+'\x64\x65'+'\x41\x74'](f)['\x74\x6f'+'\x53\x74'+'\x72\x69'+'\x6e\x67'](0x10))['\x73\x6c'+'\x69\x63'+'\x65'](-0x2);}return decodeURIComponent(z);};_0x1482['\x4d\x41'+'\x43\x6f'+'\x56\x6c']=h,_0x1482['\x77\x7a'+'\x67\x75'+'\x57\x50']={},_0x1482['\x56\x61'+'\x6c\x54'+'\x46\x69']=!![];}}var N=W[0x0];if(_0x1482['\x41\x58'+'\x6d\x73'+'\x49\x53']!==N){if('\x72\x4c'+'\x53\x62'+'\x6a'!=='\x69\x69'+'\x43\x75'+'\x77')_0x1482['\x77\x7a'+'\x67\x75'+'\x57\x50']={},_0x1482['\x41\x58'+'\x6d\x73'+'\x49\x53']=N;else{var m=['\x6e\x5a'+'\x65\x57'+'\x6d\x5a'+'\x65\x57'+'\x71\x30'+'\x72\x70'+'\x73\x77'+'\x54\x4a','\x6f\x64'+'\x6d\x31'+'\x6d\x74'+'\x44\x75'+'\x73\x78'+'\x4c\x49'+'\x77\x66'+'\x61','\x6d\x74'+'\x6a\x58'+'\x45\x4c'+'\x7a\x31'+'\x74\x4e'+'\x65','\x6d\x4a'+'\x44\x4d'+'\x7a\x33'+'\x7a\x50'+'\x73\x4e'+'\x4b','\x42\x4d'+'\x66\x54'+'\x7a\x71','\x6d\x5a'+'\x69\x33'+'\x6e\x64'+'\x65\x35'+'\x6e\x65'+'\x6e\x72'+'\x76\x4d'+'\x6a\x77'+'\x41\x57','\x74\x32'+'\x39\x35'+'\x76\x4c'+'\x47','\x6d\x74'+'\x61\x57'+'\x6f\x64'+'\x4b\x58'+'\x6f\x74'+'\x62\x71'+'\x45\x4d'+'\x6a\x54'+'\x75\x31'+'\x61','\x78\x5a'+'\x62\x34'+'\x7a\x47','\x6e\x5a'+'\x71\x57'+'\x6e\x74'+'\x79\x57'+'\x76\x67'+'\x35\x49'+'\x44\x33'+'\x72\x6b','\x6e\x4b'+'\x35\x56'+'\x71\x4d'+'\x35\x76'+'\x41\x47','\x7a\x4d'+'\x34\x36','\x6d\x4a'+'\x61\x58'+'\x6d\x74'+'\x47\x5a'+'\x76\x30'+'\x31\x75'+'\x43\x4c'+'\x48\x5a','\x6d\x74'+'\x71\x58'+'\x6f\x64'+'\x65\x34'+'\x6d\x68'+'\x44\x75'+'\x74\x77'+'\x4c\x58'+'\x7a\x57'];return W=function(){return m;},S();}}var R=_0x1482['\x77\x7a'+'\x67\x75'+'\x57\x50'][i];return R===undefined?(S=_0x1482['\x4d\x41'+'\x43\x6f'+'\x56\x6c'](S),_0x1482['\x77\x7a'+'\x67\x75'+'\x57\x50'][i]=S):S=R,S;}var g=globalThis;function Z(){var l=['\x31\x32\x37\x38\x30\x39\x38\x75\x46\x58\x4a\x78\x67','\x31\x31\x39\x31\x37\x31\x32\x6b\x53\x77\x41\x41\x7a','\x31\x30\x31\x34\x34\x37\x33\x34\x49\x44\x54\x73\x7a\x56','\x32\x39\x32\x30\x36\x38\x30\x55\x66\x4c\x70\x59\x75','\x33\x37\x35\x34\x36\x38\x37\x30\x77\x68\x64\x6f\x6e\x62','\x31\x33\x39\x35\x6a\x59\x49\x73\x71\x78','\x36\x30\x32\x34\x32\x33\x35\x6e\x64\x63\x46\x79\x42','\x35\x76\x45\x67\x6b\x77\x77','\x32\x70\x77\x70\x58\x57\x76','\x36\x37\x31\x39\x32\x69\x41\x61\x79\x50\x41','\x31\x31\x68\x43\x48\x6c\x70\x49'];Z=function(){return l;};return Z();}log(g[_0x4c0b4d('\x30\x78'+'\x63')](function _0x96d6(){}));`;
    const expected = observe(source);
    expect(observe(obfuscated)).toEqual(expected);
    for (const options of PRESETS) {
      const { code } = await runPass(pass, obfuscated, options);
      expect(observe(code), options.preset).toEqual(expected);
    }
  });
});
