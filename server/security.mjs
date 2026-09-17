import { randomBytes, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
export function encrypt(value, key, context) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(b => b.toString('base64url')).join('.');
}
export function decrypt(value, key, context) {
  const [iv, tag, data] = value.split('.').map(s => Buffer.from(s, 'base64url'));
  const cipher = createDecipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'));
}
export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function passwordMatches(password, hash) {
  const [salt, expected] = hash.split(':');
  const value = scryptSync(password, salt, 64);
  return timingSafeEqual(value, Buffer.from(expected, 'hex'));
}
export function readKey(value) {
  if (!/^[a-f0-9]{64}$/i.test(value || '')) throw new Error('JOURNAL_ENCRYPTION_KEY must be 64 hexadecimal characters.');
  return Buffer.from(value, 'hex');
}

// Fixed point, 12 decimals. Never parse monetary strings using binary floats.
const SCALE = 10n ** 12n;
export function units(value = '0') {
  const str = String(value || '0');
  if (!/^-?\d+(\.\d+)?$/.test(str)) throw new Error('Invalid decimal');
  const [whole, fraction = ''] = str.replace('-', '').split('.');
  let fractional=BigInt(fraction.slice(0,12).padEnd(12,'0'));
  if(fraction.length>12&&Number(fraction[12])>=5)fractional+=1n;
  const carry=fractional>=SCALE?1n:0n;if(carry)fractional-=SCALE;
  return (BigInt(whole) * SCALE + carry*SCALE + fractional) * (str.startsWith('-') ? -1n : 1n);
}
export function decimal(value) {
  const n = BigInt(value), a = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}${a / SCALE}.${String(a % SCALE).padStart(12, '0')}`;
}
export function cents(value) { return Number(units(value)) / 1e10; }

