/* TagMe (API de Bot): achar a reserva do cliente pelo telefone e confirmar.
   Formato das respostas: dedução a partir de notas-time/pesquisa-tagme-api.md
   (não temos a chave nem o NDA). Tudo que é incerto está marcado "dedução". */
'use strict';
const util = require('./util');

const URL_PADRAO = 'https://reservationpartnersapi.azurewebsites.net';

function configurado(env) { return !!(env.TAGME_PARTNER_APP_ID && env.TAGME_VENUE_ID); }
function base(env) { return String(env.TAGME_BOT_API_URL || URL_PADRAO).replace(/\/+$/, ''); }
function cab(env) { return { partnerAppId: env.TAGME_PARTNER_APP_ID, Accept: 'application/json', 'Content-Type': 'application/json' }; }
function erroTM(msg, status) { const e = new Error(msg); e.tipo = 'tagme'; e.status = status; return e; }

/* a lista pode vir como array puro ou dentro de um objeto (dedução) */
function extrairLista(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') for (const k of ['reservations', 'data', 'items', 'result']) if (Array.isArray(json[k])) return json[k];
  return [];
}

/* lista as reservas do telefone (nacional: DDD + número). Tenta sem 55 e com 55; para na primeira resposta com reservas. */
async function buscarPorTelefone(env, foneNacional, deps) {
  let ultimoErro = null, algumaOk = false;
  for (const v of util.variantesFone(foneNacional)) {
    const r = await util.buscar(base(env) + '/reservations/' + encodeURIComponent(env.TAGME_VENUE_ID) + '/by-phone/' + encodeURIComponent(v),
      { method: 'GET', headers: cab(env) }, deps).catch(function (e) { ultimoErro = e; return null; });
    if (!r) continue;
    if (r.status === 404) { algumaOk = true; continue; }
    if (!r.ok) { ultimoErro = erroTM('by-phone: http ' + r.status, r.status); continue; }
    algumaOk = true;
    const lista = extrairLista(r.json);
    if (lista.length) return lista;
  }
  if (!algumaOk && ultimoErro) throw ultimoErro;
  return [];
}

async function confirmar(env, reservaId, deps) {
  const r = await util.buscar(base(env) + '/reservations/confirm/' + encodeURIComponent(env.TAGME_VENUE_ID) + '/' + encodeURIComponent(reservaId),
    { method: 'PUT', headers: cab(env) }, deps);
  if (!r.ok) throw erroTM('confirm: http ' + r.status, r.status);
  return true;
}

/* Escolha da reserva: mesmo dia (de São Paulo), mesmo partySize, status New ou Confirmed, e EXATAMENTE uma.
   Se TAGME_SECTION_TRADICIONAL / TAGME_SECTION_FUSION existirem, o ambiente também tem de bater. */
function escolher(env, lista, dia, pessoas, piso) {
  const secao = piso === 1 ? env.TAGME_SECTION_TRADICIONAL : piso === 2 ? env.TAGME_SECTION_FUSION : '';
  const achadas = (lista || []).filter(function (r) {
    if (!r || typeof r !== 'object') return false;
    if (r.status !== 'New' && r.status !== 'Confirmed') return false;
    if (Number(r.partySize) !== pessoas) return false;
    if (util.diaSP(r.reservationDay) !== dia) return false;
    if (secao && String(r.section) !== String(secao)) return false;
    return !!r._id;
  });
  if (achadas.length === 0) return { motivo: 'nenhuma' };
  if (achadas.length > 1) return { motivo: 'varias' };
  return { reserva: achadas[0] };
}

function codigoDe(id) { return String(id).slice(-6).toUpperCase(); }
function horaDe(r) { return r && r.reservationTime ? String(r.reservationTime).slice(0, 5) : null; }
function publica(r) {
  return { codigo: codigoDe(r._id), dia: util.diaSP(r.reservationDay), hora: horaDe(r), pessoas: Number(r.partySize), status: r.status === 'Confirmed' ? 'confirmada' : 'nova' };
}

/* Confirma depois do Pix aprovado. meta: { reservaId, fone (nacional), dia, pessoas }.
   Só confirma reserva New; se já está Confirmed devolve ja_confirmada. Qualquer erro vira pendente_manual.

   Confirmação única (D1). A consulta de status e o webhook chegam juntos; sem banco, o que dá para fazer sem dependência é:
   (a) trava em memória por reservaId: quem chega durante uma confirmação espera e recebe o mesmo resultado;
   (b) cache de 10 min do que já foi confirmado: quem chega depois recebe ja_confirmada (como já era), sem falar com o TagMe;
   (c) se o PUT falha, relê a reserva: se já está Confirmed no TagMe, vira ja_confirmada.
   LIMITE QUE SOBRA: a memória é de cada instância da Vercel; duas instâncias diferentes ainda podem mandar dois PUTs ao mesmo tempo.
   Se isso é inofensivo depende de saber, depois do NDA, se o PUT repetido de confirmação do TagMe não faz nada (ou só reenvia aviso). */
const CACHE_CONFIRMADAS_MS = 10 * 60 * 1000;
const emAndamento = new Map();    /* reservaId -> Promise do resultado */
const confirmadas = new Map();    /* reservaId -> { res, ate } */

function limparConfirmacoes() { emAndamento.clear(); confirmadas.clear(); }

async function confirmarReservaPaga(env, meta, deps) {
  const id = String(meta.reservaId);
  const t = deps && deps.agora ? deps.agora() : Date.now();
  const c = confirmadas.get(id);
  if (c && c.ate > t) return Object.assign({}, c.res, { estado: 'ja_confirmada' });
  if (c) confirmadas.delete(id);
  if (emAndamento.has(id)) return Object.assign({}, await emAndamento.get(id));
  const p = confirmarSemTrava(env, meta, deps);
  emAndamento.set(id, p);
  try {
    const r = await p;
    if (r.estado === 'confirmada') {
      confirmadas.set(id, { res: r, ate: t + CACHE_CONFIRMADAS_MS });
      if (confirmadas.size > 500) confirmadas.delete(confirmadas.keys().next().value);
    }
    return r;
  } finally { emAndamento.delete(id); }
}

async function confirmarSemTrava(env, meta, deps) {
  const manual = { estado: 'pendente_manual', codigo: codigoDe(meta.reservaId), dia: meta.dia, hora: null, pessoas: meta.pessoas, simulado: false };
  try {
    const lista = await buscarPorTelefone(env, meta.fone, deps);
    const r = lista.find(function (x) { return x && String(x._id) === String(meta.reservaId); });
    if (!r) return manual;
    const hora = horaDe(r);
    const resp = function (estado) { return { estado: estado, codigo: codigoDe(r._id), dia: util.diaSP(r.reservationDay), hora: hora, pessoas: Number(r.partySize), simulado: false }; };
    if (r.status === 'Confirmed') return resp('ja_confirmada');
    if (r.status !== 'New') return Object.assign(manual, { hora: hora });
    try { await confirmar(env, r._id, deps); }
    catch (e) {
      /* o PUT falhou: se a reserva já está confirmada (outra instância ou o webhook foi na frente), é sucesso */
      let outra = null;
      try { outra = (await buscarPorTelefone(env, meta.fone, deps)).find(function (x) { return x && String(x._id) === String(meta.reservaId); }); } catch (e2) { outra = null; }
      if (outra && outra.status === 'Confirmed') return resp('ja_confirmada');
      throw e;
    }
    return resp('confirmada');
  } catch (e) {
    util.log('tagme_falha_confirmacao', { msg: String(e && e.message), fone: meta.fone }, 'erro');
    return manual;
  }
}

module.exports = { configurado, buscarPorTelefone, confirmar, escolher, publica, codigoDe, confirmarReservaPaga, limparConfirmacoes };
