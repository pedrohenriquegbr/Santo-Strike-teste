/* Mercado Pago: criar Pix, buscar pagamento, validar assinatura do webhook.
   Endereço base em MP_API_URL (padrão https://api.mercadopago.com) para testar
   contra um servidor falso. Nada aqui guarda chave: o token vem de env. */
'use strict';
const crypto = require('crypto');
const util = require('./util');

const VALIDADE_MS = 30 * 60 * 1000 + 30 * 1000;    /* 30 min + 30 s: o mínimo aceito é 30 min depois da emissão */

function base(env) { return String(env.MP_API_URL || 'https://api.mercadopago.com').replace(/\/+$/, ''); }
function cab(env, extra) {
  return Object.assign({ Authorization: 'Bearer ' + env.MP_ACCESS_TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' }, extra || {});
}
function erroMP(msg, status) { const e = new Error(msg); e.tipo = 'mp'; e.status = status; return e; }

/* dados: { valor, descricao, tentativa, email, nome, externalReference, metadata, notificationUrl, agora } */
async function criarPix(env, dados, deps) {
  const t = dados.agora == null ? Date.now() : dados.agora;
  const corpo = {
    transaction_amount: dados.valor,
    description: String(dados.descricao).slice(0, 250),
    payment_method_id: 'pix',
    payer: { email: dados.email },
    date_of_expiration: util.isoSP(t + VALIDADE_MS),
    external_reference: dados.externalReference,
    metadata: dados.metadata
  };
  if (dados.nome) {
    const p = String(dados.nome).trim().split(/\s+/);
    corpo.payer.first_name = p[0].slice(0, 60);
    if (p.length > 1) corpo.payer.last_name = p.slice(1).join(' ').slice(0, 60);
  }
  if (dados.notificationUrl) corpo.notification_url = dados.notificationUrl;
  /* a mesma tentativa gera sempre a mesma chave: o Mercado Pago devolve a mesma cobrança */
  const chave = 'ss-' + crypto.createHash('sha256').update('tentativa:' + dados.tentativa + '|' + (dados.idemExtra || '')).digest('hex').slice(0, 48);
  const r = await util.buscar(base(env) + '/v1/payments', { method: 'POST', headers: cab(env, { 'X-Idempotency-Key': chave }), body: JSON.stringify(corpo) }, deps);
  if (!r.ok || !r.json || r.json.id == null) throw erroMP('criar pix: http ' + r.status, r.status);
  return normalizar(r.json);
}

async function buscarPagamento(env, id, deps) {
  if (!/^\d{1,20}$/.test(String(id))) return null;
  const r = await util.buscar(base(env) + '/v1/payments/' + id, { method: 'GET', headers: cab(env) }, deps);
  if (r.status === 404) return null;
  if (!r.ok || !r.json || r.json.id == null) throw erroMP('buscar pagamento: http ' + r.status, r.status);
  return normalizar(r.json);
}

/* pagamentos de uma external_reference, do mais novo para o mais antigo (D2). Lança erro se a busca falhar. */
/* D9: cancela um Pix ainda pendente (PUT status=cancelled; o Mercado Pago só aceita em pending/in_process).
   Devolve o pagamento normalizado, null se não existe. Lança erro se o Mercado Pago recusar ou não responder. */
async function cancelarPagamento(env, id, deps) {
  if (!/^\d{1,20}$/.test(String(id))) return null;
  const r = await util.buscar(base(env) + '/v1/payments/' + id, { method: 'PUT', headers: cab(env), body: JSON.stringify({ status: 'cancelled' }) }, deps);
  if (r.status === 404) return null;
  if (!r.ok || !r.json || r.json.id == null) throw erroMP('cancelar pagamento: http ' + r.status, r.status);
  return normalizar(r.json);
}

async function buscarPorReferencia(env, referencia, deps) {
  const r = await util.buscar(base(env) + '/v1/payments/search?external_reference=' + encodeURIComponent(referencia) + '&sort=date_created&criteria=desc', { method: 'GET', headers: cab(env) }, deps);
  if (!r.ok || !r.json || !Array.isArray(r.json.results)) throw erroMP('buscar por referencia: http ' + r.status, r.status);
  return r.json.results.filter(function (x) { return x && x.id != null && x.external_reference === referencia; }).map(normalizar);
}

function normalizar(p) {
  const td = (p.point_of_interaction && p.point_of_interaction.transaction_data) || {};
  let qr = null;
  if (td.qr_code_base64) qr = 'data:image/' + (String(td.qr_code_base64).indexOf('/9j/') === 0 ? 'jpeg' : 'png') + ';base64,' + td.qr_code_base64;
  const exp = p.date_of_expiration ? new Date(p.date_of_expiration) : null;
  return {
    id: String(p.id), status: p.status, statusDetail: p.status_detail || null, valor: p.transaction_amount,
    copiaECola: td.qr_code || null, qrImagem: qr,
    expiraEm: exp && !isNaN(exp.getTime()) ? exp.toISOString() : null,
    pagoEm: p.date_approved ? new Date(p.date_approved).toISOString() : null,
    metadata: p.metadata || {}, externalReference: p.external_reference || null
  };
}

/* approved -> aprovado; pending/in_process/authorized -> pendente; cancelled por vencimento -> expirado;
   rejected/cancelled -> recusado; refunded/charged_back -> estornado. Pix pendente já vencido também vira expirado. */
function mapearStatus(pg, agora) {
  const t = agora == null ? Date.now() : agora;
  switch (pg.status) {
    case 'approved': return 'aprovado';
    case 'refunded': case 'charged_back': return 'estornado';
    case 'cancelled':
      return pg.statusDetail === 'expired' || (pg.expiraEm && t >= new Date(pg.expiraEm).getTime()) ? 'expirado' : 'recusado';
    case 'rejected': return 'recusado';
    default:
      if (pg.expiraEm && t > new Date(pg.expiraEm).getTime() + 120000) return 'expirado';
      return 'pendente';
  }
}

/* Cabeçalho x-signature: "ts=1704908010,v1=<hex>". Manifesto: "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
   com HMAC-SHA256 em hexadecimal e a chave secreta do webhook. Pares ausentes saem do manifesto. */
function validarAssinaturaWebhook(segredo, o) {
  if (!segredo || !o || typeof o.xSignature !== 'string') return false;
  let ts = null, v1 = null;
  o.xSignature.split(',').forEach(function (par) {
    const i = par.indexOf('=');
    if (i < 0) return;
    const k = par.slice(0, i).trim(), v = par.slice(i + 1).trim();
    if (k === 'ts') ts = v; else if (k === 'v1') v1 = v;
  });
  if (!ts || !v1) return false;
  let id = o.dataId == null ? '' : String(o.dataId);
  if (/^[a-z0-9]+$/i.test(id)) id = id.toLowerCase();
  let manifesto = '';
  if (id) manifesto += 'id:' + id + ';';
  if (o.xRequestId) manifesto += 'request-id:' + o.xRequestId + ';';
  manifesto += 'ts:' + ts + ';';
  return util.iguais(v1.toLowerCase(), util.hmacHex(segredo, manifesto));
}

module.exports = { criarPix, buscarPagamento, cancelarPagamento, buscarPorReferencia, validarAssinaturaWebhook, mapearStatus, VALIDADE_MS };
