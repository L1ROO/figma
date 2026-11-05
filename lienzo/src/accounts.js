// Cuentas sin usuario: cada cuenta se identifica solo por su contraseña.
// La contraseña nunca se guarda: se guarda un hash scrypt con una "pimienta" secreta del servidor,
// que sirve a la vez para buscar la cuenta (no hay nombre de usuario con qué buscarla).

import crypto from 'node:crypto';
import { kvGet, kvSet, addDoc, claimOrphanDocs } from './store.js';

const SESSION_DAYS = 90;
let pepper = null;
let accounts = {};   // id -> { id, key, mcpKey, createdAt }
let sessions = {};   // token -> { accountId, createdAt }
const byKey = new Map();
const byMcp = new Map();

export function initAccounts() {
  const meta = kvGet('meta', {});
  if (!meta.pepper) {
    meta.pepper = crypto.randomBytes(32).toString('hex');
    kvSet('meta', meta);
  }
  pepper = meta.pepper;
  accounts = kvGet('accounts', {});
  sessions = kvGet('sessions', {});
  for (const a of Object.values(accounts)) { byKey.set(a.key, a); byMcp.set(a.mcpKey, a); }
  // Borrar sesiones vencidas
  const limit = Date.now() - SESSION_DAYS * 864e5;
  let pruned = false;
  for (const [t, s] of Object.entries(sessions)) if (s.createdAt < limit || !accounts[s.accountId]) { delete sessions[t]; pruned = true; }
  if (pruned) kvSet('sessions', sessions);
  console.log(`[cuentas] ${Object.keys(accounts).length} cuentas`);
}

const random = (n) => crypto.randomBytes(n).toString('base64url');

function hash(password) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), pepper, 32, { N: 16384, r: 8, p: 1 }, (err, buf) => (err ? reject(err) : resolve(buf.toString('hex'))));
  });
}

function newSession(accountId) {
  const token = random(32);
  sessions[token] = { accountId, createdAt: Date.now() };
  kvSet('sessions', sessions);
  return token;
}

export class AuthError extends Error {}

export async function signup(password) {
  if (typeof password !== 'string' || password.length < 4) throw new AuthError('La contraseña tiene que tener al menos 4 caracteres.');
  if (password.length > 200) throw new AuthError('La contraseña es demasiado larga.');
  const key = await hash(password);
  if (byKey.has(key)) throw new AuthError('Esa contraseña no se puede usar. Elegí otra.');
  const first = Object.keys(accounts).length === 0;
  const a = { id: crypto.randomUUID(), key, mcpKey: random(24), createdAt: Date.now() };
  accounts[a.id] = a;
  byKey.set(key, a);
  byMcp.set(a.mcpKey, a);
  kvSet('accounts', accounts);
  // La primera cuenta se queda con los diseños que ya existían; las demás arrancan con uno vacío
  const claimed = first ? claimOrphanDocs(a.id) : 0;
  if (!claimed) addDoc('Mi primer diseño', a.id);
  return { token: newSession(a.id), claimed };
}

export async function login(password) {
  if (typeof password !== 'string' || !password) throw new AuthError('Escribí tu contraseña.');
  const a = byKey.get(await hash(password));
  if (!a) throw new AuthError('Esa contraseña no corresponde a ninguna cuenta.');
  return { token: newSession(a.id) };
}

export function logout(token) {
  if (sessions[token]) { delete sessions[token]; kvSet('sessions', sessions); }
}

export function accountFromSession(token) {
  const s = token && sessions[token];
  if (!s || !accounts[s.accountId]) return null;
  if (s.createdAt < Date.now() - SESSION_DAYS * 864e5) { logout(token); return null; }
  return accounts[s.accountId];
}

export function accountFromMcpKey(key) {
  return (key && byMcp.get(key)) || null;
}

export function regenerateMcpKey(accountId) {
  const a = accounts[accountId];
  byMcp.delete(a.mcpKey);
  a.mcpKey = random(24);
  byMcp.set(a.mcpKey, a);
  kvSet('accounts', accounts);
  return a.mcpKey;
}

// Límite simple de intentos fallidos por IP, para que no se puedan probar contraseñas en masa
const attempts = new Map();
const WINDOW = 15 * 60e3;
function entry(ip) {
  const now = Date.now();
  let e = attempts.get(ip);
  if (!e || now > e.reset) { e = { n: 0, reset: now + WINDOW }; attempts.set(ip, e); }
  if (attempts.size > 5000) attempts.clear();
  return e;
}
export function isBlocked(ip) { return entry(ip).n >= 15; }
export function registerFailure(ip) { entry(ip).n++; }
