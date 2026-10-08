import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deobfuscate } from '../src/index.js';
import type { PresetName } from '../src/types.js';

/**
 * obfuscator.io's `renameGlobals` with `identifierNamesGenerator:
 * 'mangled-shuffled'`: the string array, the decoder and the program's own
 * functions are all one letter, and the generator reuses those letters for
 * parameters - below, the decoder is `x(L, Y)` and `L` and `Y` are the
 * program's two functions, so inside the decoder each name is the parameter
 * and outside it the function. What must hold: the strings decode, the
 * machinery goes, every reference resolves to the binding it was written
 * against, and a name the evidence reaches is given however short the one
 * it replaces, while a short name with no evidence is left as it is at
 * balanced and given a fallback at aggressive.
 *
 * The inputs are the obfuscator's own output for
 *
 *     function greet(name, punct) { return 'Hello, ' + name + punct; }
 *     function shout(text) { return text.toUpperCase() + '!!'; }
 *     log(greet('World', '!'), shout(greet('Moon', '?')));
 *
 * under `renameGlobals`, `mangled-shuffled`, `stringArray` at threshold 1,
 * seed 1, stored rather than regenerated: the obfuscator carries state between
 * calls in one process, so what it emits for a given seed is not fixed.
 */

const PRESETS: PresetName[] = ['conservative', 'balanced', 'aggressive'];
const EXPECTED = ['Hello, World! HELLO, MOON?!!'];

/** `stringArrayEncoding: ['none']`, `stringArrayWrappersCount: 0`. */
const PLAIN = String.raw`var P=x;function w(){var T=['Moon','4UjABbn','26277fMbiSl','Hello,\x20','1582460YDyoSf','World','441mRKAWH','31926wPvBRU','649344wADgcr','toUpperCase','1467972DobrxE','965792auOIvR','12381687ygtZpJ'];w=function(){return T;};return w();}(function(t,U){var k=x,h=t();while(!![]){try{var l=-parseInt(k(0x116))/0x1+parseInt(k(0x11c))/0x2*(parseInt(k(0x11d))/0x3)+parseInt(k(0x118))/0x4+-parseInt(k(0x11f))/0x5+-parseInt(k(0x122))/0x6*(parseInt(k(0x121))/0x7)+-parseInt(k(0x119))/0x8+parseInt(k(0x11a))/0x9;if(l===U)break;else h['push'](h['shift']());}catch(B){h['push'](h['shift']());}}}(w,0x52a27));function L(t,U){var H=x;return H(0x11e)+t+U;}function x(L,Y){L=L-0x116;var t=w();var U=t[L];return U;}function Y(t){var F=x;return t[F(0x117)]()+'!!';}log(L(P(0x120),'!'),Y(L(P(0x11b),'?')));`;

/** `stringArrayEncoding: ['base64']`, `stringArrayWrappersCount: 0`. */
const BASE64 = String.raw`(function(t,U){var h=t();while(!![]){try{var l=-parseInt(x(0x116))/0x1+parseInt(x(0x11c))/0x2*(parseInt(x(0x11d))/0x3)+parseInt(x(0x118))/0x4+-parseInt(x(0x11f))/0x5+-parseInt(x(0x122))/0x6*(parseInt(x(0x121))/0x7)+-parseInt(x(0x119))/0x8+parseInt(x(0x11a))/0x9;if(l===U)break;else h['push'](h['shift']());}catch(B){h['push'](h['shift']());}}}(w,0x52a27));function L(t,U){return x(0x11e)+t+U;}function Y(t){return t[x(0x117)]()+'!!';}log(L(x(0x120),'!'),Y(L(x(0x11b),'?')));function x(L,Y){L=L-0x116;var t=w();var U=t[L];if(x['VqlbKJ']===undefined){var h=function(H){var F='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';var P='',T='';for(var g=0x0,j,n,r=0x0;n=H['charAt'](r++);~n&&(j=g%0x4?j*0x40+n:n,g++%0x4)?P+=String['fromCharCode'](0xff&j>>(-0x2*g&0x6)):0x0){n=F['indexOf'](n);}for(var y=0x0,z=P['length'];y<z;y++){T+='%'+('00'+P['charCodeAt'](y)['toString'](0x10))['slice'](-0x2);}return decodeURIComponent(T);};x['pJRtUb']=h,x['JnGEEE']={},x['VqlbKJ']=!![];}var l=t[0x0];x['pRCrBz']!==l&&(x['JnGEEE']={},x['pRCrBz']=l);var B=x['JnGEEE'][L];return B===undefined?(U=x['pJRtUb'](U),x['JnGEEE'][L]=U):U=B,U;}function w(){var k=['tw9VBG','nfvQqujIBG','mJyYnZDMtwjPu2W','sgvSBg8Sia','mtu4mJq2mfLeEw9tzG','v29YBgq','ndqXBvjlqvDi','mZe5mJz3uhzcuLu','nJq5mZq0D0fez2nY','Dg9vChbLCKnHC2u','mtq2nZK3mKrVyNj4rq','oty1nZKYyxvpsxzs','mtiZode2odD5z3rACeO'];w=function(){return k;};return w();}`;

/**
 * `stringArrayEncoding: ['base64', 'rc4']`, `stringArrayWrappersCount: 0` -
 * two decoders, `x(L, Y)` and `L(x, Y)`, each shadowing the other's name with
 * its first parameter, and the program's `greet` is `Y(U, h)`, the decoders'
 * second parameter's letter. The strings pass cracks this pair, so every call
 * inside `greet` has to resolve through the shadowing to the right decoder for
 * the program to decode at all.
 */
const TWO_ENCODINGS = String.raw`(function(U,h){var l=U();while(!![]){try{var B=-parseInt(L(0x11e,'uaY3'))/0x1+parseInt(x(0x11a))/0x2+parseInt(x(0x120))/0x3+-parseInt(x(0x117))/0x4+parseInt(x(0x123))/0x5*(-parseInt(x(0x119))/0x6)+parseInt(L(0x121,'Mxh@'))/0x7+parseInt(x(0x11d))/0x8;if(B===h)break;else l['push'](l['shift']());}catch(k){l['push'](l['shift']());}}}(w,0x72af4));function x(L,Y){L=L-0x116;var t=w();var U=t[L];if(x['qlbKJp']===undefined){var h=function(H){var F='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';var P='',T='';for(var g=0x0,j,n,r=0x0;n=H['charAt'](r++);~n&&(j=g%0x4?j*0x40+n:n,g++%0x4)?P+=String['fromCharCode'](0xff&j>>(-0x2*g&0x6)):0x0){n=F['indexOf'](n);}for(var y=0x0,z=P['length'];y<z;y++){T+='%'+('00'+P['charCodeAt'](y)['toString'](0x10))['slice'](-0x2);}return decodeURIComponent(T);};x['JRtUbJ']=h,x['nGEEEp']={},x['qlbKJp']=!![];}var l=t[0x0];x['RCrBzW']!==l&&(x['nGEEEp']={},x['RCrBzW']=l);var B=x['nGEEEp'][L];return B===undefined?(U=x['JRtUbJ'](U),x['nGEEEp'][L]=U):U=B,U;}function Y(U,h){return L(0x116,'MoAn')+U+h;}function L(x,Y){x=x-0x116;var t=w();var U=t[x];if(L['BLcNCg']===undefined){var h=function(H){var F='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';var P='',T='';for(var g=0x0,j,n,r=0x0;n=H['charAt'](r++);~n&&(j=g%0x4?j*0x40+n:n,g++%0x4)?P+=String['fromCharCode'](0xff&j>>(-0x2*g&0x6)):0x0){n=F['indexOf'](n);}for(var y=0x0,z=P['length'];y<z;y++){T+='%'+('00'+P['charCodeAt'](y)['toString'](0x10))['slice'](-0x2);}return decodeURIComponent(T);};var k=function(H,F){var P=[],T=0x0,g,n='';H=h(H);var r;for(r=0x0;r<0x100;r++){P[r]=r;}for(r=0x0;r<0x100;r++){T=(T+P[r]+F['charCodeAt'](r%F['length']))%0x100,g=P[r],P[r]=P[T],P[T]=g;}r=0x0,T=0x0;for(var z=0x0;z<H['length'];z++){r=(r+0x1)%0x100,T=(T+P[r])%0x100,g=P[r],P[r]=P[T],P[T]=g,n+=String['fromCharCode'](H['charCodeAt'](z)^P[(P[r]+P[T])%0x100]);}return n;};L['qSbFXh']=k,L['dXTydp']={},L['BLcNCg']=!![];}var l=t[0x0];L['Tmipjc']!==l&&(L['dXTydp']={},L['Tmipjc']=l);var B=L['dXTydp'][x];return B===undefined?(L['BRMMFA']===undefined&&(L['BRMMFA']=!![]),U=L['qSbFXh'](U,Y),L['dXTydp'][x]=U):U=B,U;}function t(U){return U[x(0x118)]()+'!!';}function w(){var H=['W4DnWO/cGG','W77cLmkYb1OjWRldTmorW7JdJCk7W5i','aMFcISkLW7eVFa','mJiXnZuZnKvzrhLVuW','Dg9vChbLCKnHC2u','mZq4mZe4vw1ss0fx','mtuZnduZmg5MtwjPuW','v29YBgq','WO/dVmolW54bWRy9WRGGW4DpW48','mZe4ndmWnfj5z3rACa','AqCtW6VcQshdPNSmfr/cPa','mZmXnJq2sgf1t0L2','nti0nJqZBerVyNj4','WOFdH8o+sIO7WPhdTvDdmCkC','E2H6WOqNWPCjdwRcGvRcRG','nwz3uhzcuG'];w=function(){return H;};return w();}log(Y(x(0x11b),'!'),t(Y(L(0x124,'p%yD'),'?')));`;

function observe(code: string): string[] {
  const logs: string[] = [];
  const context = vm.createContext({
    log: (...values: unknown[]) => logs.push(values.map(String).join(' ')),
  });
  vm.runInContext(code, context, { timeout: 5_000 });
  return logs;
}

function has(code: string, name: string): boolean {
  return new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(code);
}

describe('mangled globals shadowed by the parameters that reuse their letters', () => {
  for (const [label, input] of [
    ['plain', PLAIN],
    ['base64', BASE64],
  ] as const) {
    it(`decodes the ${label} table, drops the machinery and names what the evidence reaches`, async () => {
      expect(observe(input)).toEqual(EXPECTED);
      for (const preset of PRESETS) {
        const { code, metadata } = await deobfuscate(input, { preset });
        expect(observe(code), preset).toEqual(EXPECTED);
        expect(metadata.stats.verified, preset).toBe(true);
        if (preset === 'conservative') continue;
        expect(code, preset).toContain("'Hello, World!'");
        expect(code, preset).toContain("'HELLO, MOON?!!'");
        expect(code, preset).not.toContain('parseInt');
        // The decoder `x`, the table `w` and the alias `P` are gone with the
        // strings; the functions are named for what they return and their
        // parameters for what is done with them.
        for (const letter of ['x', 'w', 'P', 'L', 'Y']) expect(has(code, letter), `${preset} ${letter}`).toBe(false);
        expect(code, preset).toMatch(/function toText\(text, [\w$]+\) \{\s*return 'Hello, ' \+ text \+ [\w$]+;/);
        expect(code, preset).toMatch(/function toText2\(text\) \{\s*return text\.toUpperCase\(\) \+ '!!';/);
      }
      // `U`, the second parameter, has no evidence: a short name is not
      // withheld and not renamed for being short - balanced leaves it and
      // aggressive gives it the fallback every unnamed parameter gets.
      const balanced = await deobfuscate(input, { preset: 'balanced' });
      expect(balanced.code).toMatch(/function toText\(text, U\)/);
      const aggressive = await deobfuscate(input, { preset: 'aggressive' });
      expect(aggressive.code).toMatch(/function toText\(text, arg1\)/);
    });
  }

  it('dissolves two mutually-shadowing decoders and names what the evidence reaches', async () => {
    // base64 + rc4: the decoders `x(L, Y)` and `L(x, Y)` each shadow the
    // other's letter with their first parameter, and `greet` is `Y(U, h)`.
    // The strings pass cracks the pair, so nothing is left resolving to a
    // decoder - that every reference followed the shadowing through is proved
    // by a fully decoded, verified program, not by a surviving decoder name.
    expect(observe(TWO_ENCODINGS)).toEqual(EXPECTED);
    for (const preset of PRESETS) {
      const { code, metadata } = await deobfuscate(TWO_ENCODINGS, { preset });
      expect(observe(code), preset).toEqual(EXPECTED);
      expect(metadata.stats.verified, preset).toBe(true);
      if (preset === 'conservative') continue;
      expect(code, preset).toContain("'Hello, World!'");
      expect(code, preset).toContain("'HELLO, MOON?!!'");
      expect(code, preset).not.toContain('parseInt');
      // Both decoders `x` and `L`, the table `w` and the rc4 machinery are
      // gone; the two functions are named for what they return.
      for (const letter of ['x', 'w', 'L', 'Y', 't']) expect(has(code, letter), `${preset} ${letter}`).toBe(false);
      expect(code, preset).toMatch(/function toText\(text, [\w$]+\) \{\s*return 'Hello, ' \+ text \+ [\w$]+;/);
      expect(code, preset).toMatch(/function toText2\(text\) \{\s*return text\.toUpperCase\(\) \+ '!!';/);
    }
    // The undecided second parameter of `greet` is not withheld and not
    // renamed for being short: balanced leaves it, aggressive gives it the
    // fallback every unnamed parameter gets.
    const balanced = await deobfuscate(TWO_ENCODINGS, { preset: 'balanced' });
    expect(balanced.code).toMatch(/function toText\(text, h\)/);
    const aggressive = await deobfuscate(TWO_ENCODINGS, { preset: 'aggressive' });
    expect(aggressive.code).toMatch(/function toText\(text, arg1\)/);
  });
});
