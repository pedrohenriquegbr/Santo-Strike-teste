/* Utilitários das funções: log sem dado pessoal, telefone, data de São Paulo,
   fetch com tempo limite, limite de chamadas por IP, HMAC. Sem dependências. */
'use strict';
const crypto = require('crypto');

/* ---------- log em JSON (CA-02, CA-17) ----------
   Nunca grava telefone inteiro, token, e-mail, nome ou chave. Só os 4 últimos
   dígitos do telefone. */
const PROIBIDOS = /^(token|access_token|authorization|email|nome|segredo|secret|senha|password|copiaecola|qr|ref|id_reserva|reserva_id)$/i;
function fone4(v) { const d = String(v == null ? '' : v).replace(/\D/g, ''); return d ? '***' + d.slice(-4) : undefined; }
function log(evento, campos, nivel) {
  const o = { t: new Date().toISOString(), evento: evento };
  Object.keys(campos || {}).forEach(function (k) {
    if (PROIBIDOS.test(k)) return;
    if (/^fone/i.test(k)) { o[k] = fone4(campos[k]); return; }
    const v = campos[k];
    o[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  });
  (nivel === 'erro' ? console.error : console.log)(JSON.stringify(o));
}

/* ---------- telefone ---------- */
function soDigitos(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
/* 10 a 11 dígitos nacionais (DDD + número), com ou sem 55. Devolve null se não parece telefone. */
function normalizarFone(v) {
  let d = soDigitos(v);
  if (d.length >= 12 && d.length <= 13 && d.slice(0, 2) === '55') d = d.slice(2);
  return d.length === 10 || d.length === 11 ? d : null;
}
/* os dois jeitos de mandar ao TagMe: sem 55 e com 55 */
function variantesFone(nacional) { return [nacional, '55' + nacional]; }

/* ---------- data de São Paulo ---------- */
function hojeSP(agora) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(agora == null ? Date.now() : agora));
  return p;                                  /* AAAA-MM-DD */
}
/* '2025-01-28T03:00:00.000Z' (meia-noite de Brasília em UTC) vira '2025-01-28'. Só data, fica como está. */
function diaSP(v) {
  if (typeof v !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const t = new Date(v);
  if (isNaN(t.getTime())) return null;
  return hojeSP(t.getTime());
}
/* ISO com o deslocamento de São Paulo (-03:00), no formato que o Mercado Pago aceita em date_of_expiration */
function isoSP(ms) {
  const t = new Date(ms - 3 * 3600000);
  return t.toISOString().replace('Z', '-03:00');
}

/* ---------- fetch de saída com tempo limite de 8 s ---------- */
async function buscar(url, opcoes, deps) {
  const f = (deps && deps.fetch) || fetch;
  const ms = (opcoes && opcoes.tempoMs) || 8000;
  const o = Object.assign({}, opcoes); delete o.tempoMs;
  o.signal = AbortSignal.timeout(ms);
  const r = await f(url, o);
  const txt = await r.text();
  let json = null;
  if (txt) { try { json = JSON.parse(txt); } catch (e) { json = null; } }
  return { status: r.status, ok: r.status >= 200 && r.status < 300, json: json, texto: txt };
}

/* ---------- HMAC ---------- */
function hmacB64(segredo, texto) { return crypto.createHmac('sha256', segredo).update(texto).digest('base64url'); }
function hmacHex(segredo, texto) { return crypto.createHmac('sha256', segredo).update(texto).digest('hex'); }
function iguais(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
/* Segredo para assinar `token` e `ref`: PIX_SEGREDO; senão derivado do token do Mercado Pago;
   no modo de teste sem nenhum dos dois, um valor fixo (nada de valor real fica protegido por ele). */
function segredoPix(env) {
  if (env.PIX_SEGREDO) return env.PIX_SEGREDO;
  if (env.MP_ACCESS_TOKEN) return hmacHex(env.MP_ACCESS_TOKEN, 'santo-strike:pix-segredo:v1');
  if (env.SITE_TESTE === '1') return 'segredo-fixo-so-para-o-modo-simulado';
  return null;
}
/* objeto assinado: base64url(json) + '.' + assinatura */
function assinarObjeto(obj, segredo) {
  const corpo = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return corpo + '.' + hmacB64(segredo, 'obj:' + corpo);
}
function lerObjetoAssinado(texto, segredo) {
  if (typeof texto !== 'string' || texto.length > 2000) return null;
  const i = texto.lastIndexOf('.');
  if (i < 1) return null;
  const corpo = texto.slice(0, i), sig = texto.slice(i + 1);
  if (!iguais(sig, hmacB64(segredo, 'obj:' + corpo))) return null;
  try { return JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')); } catch (e) { return null; }
}
function tokenDe(id, segredo) { return hmacB64(segredo, 'tok:' + id); }
function tokenConfere(id, token, segredo) { return typeof token === 'string' && typeof id === 'string' && iguais(token, tokenDe(id, segredo)); }

/* ---------- limite simples por IP, em memória ----------
   Em função serverless cada instância tem a sua memória e ela some quando a
   instância é reciclada: isto é só um freio contra repetição acidental, não
   uma proteção de verdade. */
const baldes = new Map();
function limitar(chave, max, janelaMs, agora) {
  const t = agora == null ? Date.now() : agora;
  let l = (baldes.get(chave) || []).filter(function (x) { return t - x < janelaMs; });
  if (l.length >= max) { baldes.set(chave, l); return false; }
  l.push(t); baldes.set(chave, l);
  if (baldes.size > 5000) { baldes.forEach(function (v, k) { if (!v.length || t - v[v.length - 1] > janelaMs) baldes.delete(k); }); }
  return true;
}

module.exports = { log, fone4, soDigitos, normalizarFone, variantesFone, hojeSP, diaSP, isoSP, buscar, hmacHex, hmacB64, iguais, segredoPix,
                   assinarObjeto, lerObjetoAssinado, tokenDe, tokenConfere, limitar };
