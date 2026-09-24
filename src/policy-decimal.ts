import {MirrorError} from './errors.js';

/** Money is compared in its JSON decimal representation, without rounding a
 * native decimal string through Number or introducing a tolerance at a cap.
 * Numeric JSON inputs have already been parsed: their serialized value is the
 * most precise value available here. Provider contracts still own native units.
 */
export type PolicyDecimal=Readonly<{units:bigint;scale:number}>;
export const decimalZero:PolicyDecimal=Object.freeze({units:0n,scale:0});
const ten=(power:number)=>10n**BigInt(power);
function normalized(units:bigint,scale:number):PolicyDecimal{
 if(units===0n)return decimalZero;
 while(scale>0&&units%10n===0n){units/=10n;scale--;}
 return {units,scale};
}
export function policyDecimal(value:unknown):PolicyDecimal{
 const invalid=()=>new MirrorError('POLICY_AMOUNT_INVALID','Use a finite non-negative decimal amount with at most 324 fractional places and 512 characters.');
 if(typeof value!=='string'&&typeof value!=='number')throw invalid();
 if(typeof value==='number'&&(!Number.isFinite(value)||value<0))throw invalid();
 const text=String(value);
 if(text.length>512)throw invalid();
 const match=/^([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,3}))?$/.exec(text);
 if(!match)throw invalid();
 const fraction=match[2]??'',exponent=Number(match[3]??0);
 let scale=fraction.length-exponent,units=BigInt(match[1]+fraction);
 if(scale>324||scale< -308)throw invalid();
 if(scale<0){units*=ten(-scale);scale=0;}
 const result=normalized(units,scale),number=Number(decimalText(result));
 if(!Number.isFinite(number)||(units!==0n&&number===0))throw invalid();
 return result;
}
export function decimalText(value:PolicyDecimal):string{
 const digits=value.units.toString();
 if(value.scale===0)return digits;
 const padded=digits.padStart(value.scale+1,'0'),point=padded.length-value.scale;
 return padded.slice(0,point)+'.'+padded.slice(point);
}
function align(a:PolicyDecimal,b:PolicyDecimal){
 const scale=Math.max(a.scale,b.scale);
 return {a:a.units*ten(scale-a.scale),b:b.units*ten(scale-b.scale),scale};
}
export function compareDecimal(a:PolicyDecimal,b:PolicyDecimal):number{
 const aligned=align(a,b);return aligned.a>aligned.b?1:aligned.a<aligned.b?-1:0;
}
export function addDecimal(a:PolicyDecimal,b:PolicyDecimal):PolicyDecimal{
 const aligned=align(a,b);return normalized(aligned.a+aligned.b,aligned.scale);
}
export function positiveDecimalIncrease(after:PolicyDecimal,before:PolicyDecimal):PolicyDecimal{
 const aligned=align(after,before);return aligned.a>aligned.b?normalized(aligned.a-aligned.b,aligned.scale):decimalZero;
}
export function multiplyDecimal(a:PolicyDecimal,b:PolicyDecimal):PolicyDecimal{
 return normalized(a.units*b.units,a.scale+b.scale);
}
