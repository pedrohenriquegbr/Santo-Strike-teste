/* Lógica das quatro rotas, como funções puras:
   (entrada, env, deps) -> { status, corpo }.  entrada = { metodo, corpo, query, headers, ip, host }.
   deps (opcional): { fetch, agora } para teste. Os arquivos em api/*.js só chamam o adaptador. */
'use strict';
const crypto = require('crypto');
const util = require('./util');
const precos = require('./precos');
const mp = require('./mercadopago');
const tagme = require('./tagme');
const { erro } = require('./adaptador');

const REF_VALIDADE_MS = 60 * 60 * 1000;
const ehLocal = h => /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i.test(String(h || ''));
const cents = v => Math.round(Number(v) * 100 + 1e-6);
/* endereço do aviso do MP: o domínio de produção da Vercel (VERCEL_PROJECT_PRODUCTION_URL) vale mais que o host da requisição; nunca em localhost */
function urlWebhook(env, hostReq) {
  const h = String(env.VERCEL_PROJECT_PRODUCTION_URL || hostReq || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  return !h || ehLocal(h) ? null : 'https://' + h + '/api/mp-webhook/';
}
const agoraDe = deps => (deps && deps.agora ? deps.agora() : Date.now());

function modoMP(env) { return env.MP_ACCESS_TOKEN ? 'mp' : env.SITE_TESTE === '1' ? 'simulado' : null; }
/* o TagMe só é simulado quando o Mercado Pago também é: com Pix real e sem chave do TagMe, "indisponivel" (nunca cobrar por reserva de mentira) */
function modoTagme(env) { return env.TAGME_PARTNER_APP_ID ? 'real' : env.SITE_TESTE === '1' && !env.MP_ACCESS_TOKEN ? 'simulado' : null; }
const indisponivel = msg => erro(503, 'indisponivel', msg || 'pagamento por Pix indisponivel neste ambiente');

/* ---------- confirmação no TagMe depois do Pix aprovado ---------- */
async function confirmarNoTagme(env, m, deps) {
  if (m.sim) {
    if (env.SITE_TESTE !== '1' || env.MP_ACCESS_TOKEN) return { estado: 'indisponivel', codigo: m.codigo, dia: m.dia, hora: m.hora || null, pessoas: m.pessoas, simulado: true };
    return { estado: 'confirmada', codigo: m.codigo, dia: m.dia, hora: m.hora || '19:00', pessoas: m.pessoas, simulado: true };
  }
  if (!tagme.configurado(env)) return { estado: 'indisponivel', codigo: tagme.codigoDe(m.reservaId), dia: m.dia, hora: null, pessoas: m.pessoas, simulado: false };
  return tagme.confirmarReservaPaga(env, m, deps);
}

/* ---------- POST /api/tagme-reserva/ ---------- */
async function tagmeReserva(entrada, env, deps) {
  const segredo = util.segredoPix(env);
  const modo = modoTagme(env);
  const nao = motivo => ({ status: 200, corpo: { ok: true, achou: false, motivo: motivo } });
  if (!modo || !segredo) return nao('indisponivel');
  const c = entrada.corpo;
  if (!c || typeof c !== 'object') return erro(400, 'dados_invalidos', 'corpo ausente');
  const fone = util.normalizarFone(c.fone);
  const hoje = util.hojeSP(agoraDe(deps));
  if (!fone) return erro(400, 'dados_invalidos', 'fone invalido');
  if (!precos.validarDiaFuturo(c.dia, hoje)) return erro(400, 'dados_invalidos', 'dia invalido');
  if (!Number.isInteger(c.pessoas) || c.pessoas < 1 || c.pessoas > 500) return erro(400, 'dados_invalidos', 'pessoas invalido');
  if (c.piso !== 1 && c.piso !== 2) return erro(400, 'dados_invalidos', 'piso invalido');
  if (modo === 'real' && !tagme.configurado(env)) { util.log('tagme_sem_venue', {}, 'erro'); return nao('indisponivel'); }

  let reserva;       /* { id, hora, pessoas, status, sim } */
  if (modo === 'simulado') {
    /* só no modo simulado: "simular" força cada resposta do contrato para ver todas as telas */
    if (['nenhuma', 'varias', 'indisponivel'].indexOf(c.simular) >= 0) return nao(c.simular);
    const cod = 'TESTE' + fone.slice(-1);
    reserva = { id: 'sim-' + cod, codigo: cod, dia: c.dia, hora: '19:00', pessoas: c.pessoas, status: c.simular === 'confirmada' ? 'confirmada' : 'nova', sim: true };
  } else {
    let lista;
    try { lista = await tagme.buscarPorTelefone(env, fone, deps); }
    catch (e) { util.log('tagme_busca_falhou', { msg: String(e.message), fone: fone }, 'erro'); return nao('indisponivel'); }
    const esc = tagme.escolher(env, lista, c.dia, c.pessoas, c.piso);
    if (!esc.reserva) { util.log('tagme_busca', { achou: false, motivo: esc.motivo, fone: fone }); return nao(esc.motivo); }
    const pub = tagme.publica(esc.reserva);
    reserva = { id: String(esc.reserva._id), codigo: pub.codigo, dia: pub.dia, hora: pub.hora, pessoas: pub.pessoas, status: pub.status, sim: false };
  }
  const s = precos.sinalTagme({ dia: c.dia, pessoas: c.pessoas, piso: c.piso });
  const ref = util.assinarObjeto({ i: reserva.id, f: fone, d: c.dia, p: c.pessoas, s: c.piso, h: reserva.hora, c: reserva.codigo, st: reserva.status, sim: reserva.sim, x: agoraDe(deps) + REF_VALIDADE_MS }, segredo);
  util.log('tagme_busca', { achou: true, simulado: reserva.sim, fone: fone });
  return { status: 200, corpo: { ok: true, achou: true, simulado: reserva.sim, ref: ref,
    reserva: { codigo: reserva.codigo, dia: reserva.dia, hora: reserva.hora, pessoas: reserva.pessoas, status: reserva.status },
    rodizios: s.rodizios, valor: s.valor, descricao: s.descricao } };
}

/* ---------- POST /api/pix-criar/ ---------- */
const cacheSimulado = new Map();     /* tentativa -> resposta (modo simulado: mesma tentativa, mesma cobrança) */
const cacheSimuladoRef = new Map();  /* referência|valor|fone -> resposta (D2 no simulado: mesma reserva, tentativas diferentes, mesmo Pix) */
const travaCriacao = new Map();      /* referência -> fim da criação em andamento (D2: duas criações da mesma reserva não correm juntas) */
const canceladosSim = new Set();     /* ids simulados que a tela descartou (D9): saem do reaproveitamento e a consulta responde "recusado" */

async function pixCriar(entrada, env, deps) {
  const modo = modoMP(env), segredo = util.segredoPix(env);
  if (!modo || !segredo) return indisponivel();
  const c = entrada.corpo;
  if (!c || typeof c !== 'object') return erro(400, 'dados_invalidos', 'corpo ausente');
  const agora = agoraDe(deps), hoje = util.hojeSP(agora);
  if (c.origem !== 'reserva' && c.origem !== 'tagme') return erro(400, 'dados_invalidos', 'origem invalida');
  if (typeof c.tentativa !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(c.tentativa)) return erro(400, 'dados_invalidos', 'tentativa invalida');
  const cl = c.cliente;
  if (!cl || typeof cl !== 'object') return erro(400, 'dados_invalidos', 'cliente ausente');
  const nome = typeof cl.nome === 'string' ? cl.nome.trim() : '';
  const fone = util.normalizarFone(cl.fone);
  /* origem "tagme": a página não pede nome (só o WhatsApp); origem "reserva": obrigatório */
  if ((c.origem === 'reserva' || nome) && (nome.length < 2 || nome.length > 80)) return erro(400, 'dados_invalidos', 'nome invalido');
  if (!fone) return erro(400, 'dados_invalidos', 'fone invalido');
  let email = typeof cl.email === 'string' ? cl.email.trim() : '';
  if (email && !/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) return erro(400, 'dados_invalidos', 'email invalido');
  if (typeof c.totalCliente !== 'number' || !isFinite(c.totalCliente) || c.totalCliente <= 0) return erro(400, 'dados_invalidos', 'totalCliente invalido');

  let valor, descricao, metadata, extRef, refId, sub = null;
  if (c.origem === 'reserva') {
    if (typeof c.codigo !== 'string' || !/^[A-Za-z0-9-]{1,20}$/.test(c.codigo)) return erro(400, 'dados_invalidos', 'codigo invalido');
    let r;
    try { r = precos.calcular(c.pedido, hoje); } catch (e) { if (e.codigo === 'dados_invalidos') return erro(400, 'dados_invalidos', 'pedido invalido: ' + e.message); throw e; }
    valor = r.total; descricao = r.descricao; extRef = c.codigo; refId = c.codigo;
    const p = c.pedido;
    metadata = { origem: 'reserva', codigo: c.codigo, resumo: (p.tipo + ' ' + p.data + ' ' + (p.hora || '') + ' ' + ((p.adultos || 0) + (p.bari || 0) + (p.c35 || 0) + (p.c68 || 0) + (p.bebes || 0)) + 'p').slice(0, 100) };
  } else {
    const t = c.tagme && typeof c.tagme === 'object' ? c.tagme : null;
    const ref = t && typeof t.ref === 'string' ? util.lerObjetoAssinado(t.ref, segredo) : null;
    if (!ref || !(ref.x > agora)) return erro(409, 'reserva_nao_encontrada', 'ref invalida ou vencida');
    if (ref.sim && modo !== 'simulado') return erro(409, 'reserva_nao_encontrada', 'ref simulada nunca gera Pix real');
    if (ref.st === 'confirmada') return erro(409, 'reserva_ja_confirmada', 'a reserva ja esta confirmada; nao gera Pix');
    let s;
    try { s = precos.sinalTagme({ dia: ref.d, pessoas: ref.p, piso: ref.s }); } catch (e) { return erro(409, 'reserva_nao_encontrada', 'ref sem dados'); }
    valor = s.valor; descricao = s.descricao; extRef = 'tagme-' + ref.c; refId = ref.i;
    sub = { reservaId: ref.i, fone: ref.f, dia: ref.d, pessoas: ref.p, piso: ref.s, hora: ref.h || null, codigo: ref.c, sim: !!ref.sim };
    metadata = { origem: 'tagme', codigo: ref.c, resumo: ('tagme ' + ref.d + ' ' + ref.p + 'p piso ' + ref.s).slice(0, 100), reserva_id: ref.i, fone: ref.f, dia: ref.d, pessoas: ref.p, piso: ref.s };
    if (ref.sim) { metadata.reserva_sim = '1'; metadata.hora = ref.h || ''; }
  }
  if (cents(valor) !== cents(c.totalCliente)) {
    util.log('valor_diferente', { origem: c.origem, servidor: valor, cliente: c.totalCliente, fone: fone });
    return erro(409, 'valor_diferente', 'o total do navegador nao bate com o do servidor', { valorServidor: valor });
  }

  /* a chave de idempotência amarra a tentativa ao pedido: outro valor ou outra reserva = outra cobrança */
  const idemExtra = c.origem + '|' + cents(valor) + '|' + refId;
  if (modo === 'simulado') {
    const chave = c.tentativa + '|' + idemExtra;
    if (cacheSimulado.has(chave)) return { status: 200, corpo: cacheSimulado.get(chave) };
    const chaveRef = extRef + '|' + cents(valor) + '|' + fone, anterior = cacheSimuladoRef.get(chaveRef);
    if (anterior && Date.parse(anterior.expiraEm) > agora) { cacheSimulado.set(chave, anterior); return { status: 200, corpo: anterior }; }
    const expiraEm = new Date(agora + mp.VALIDADE_MS).toISOString();
    const numero = 'SIM-' + crypto.createHash('sha256').update(c.tentativa).digest('hex').slice(0, 8).toUpperCase();
    const id = 'sim.' + util.assinarObjeto({ v: valor, e: expiraEm, n: numero, o: c.origem, c: metadata.codigo, t: sub }, segredo);
    const corpo = { ok: true, modo: 'simulado', id: id, token: util.tokenDe(id, segredo), valor: valor, descricao: descricao,
      copiaECola: 'SIMULADO-SANTO-STRIKE-TESTE-NAO-E-UM-PIX-REAL-' + numero, qrImagem: null, expiraEm: expiraEm };
    cacheSimulado.set(chave, corpo); cacheSimuladoRef.set(chaveRef, corpo);
    if (cacheSimulado.size > 500) cacheSimulado.delete(cacheSimulado.keys().next().value);
    if (cacheSimuladoRef.size > 500) cacheSimuladoRef.delete(cacheSimuladoRef.keys().next().value);
    util.log('pix_criado', { modo: 'simulado', origem: c.origem, valor: valor, fone: fone });
    return { status: 200, corpo: corpo };
  }

  email = email || env.MP_PAYER_EMAIL_PADRAO || '';
  if (!email) { util.log('sem_email_pagador', {}, 'erro'); return indisponivel('sem e-mail do pagador e sem MP_PAYER_EMAIL_PADRAO'); }
  /* uma criação por vez para a mesma referência (dentro da instância): a segunda já enxerga a cobrança da primeira na busca */
  const anteriorTrava = travaCriacao.get(extRef) || Promise.resolve();
  let liberar; const minha = new Promise(function (r) { liberar = r; });
  const fila = anteriorTrava.then(function () { return minha; });
  travaCriacao.set(extRef, fila);
  try {
    await anteriorTrava;
    return await criarOuReusarMP(env, { c: c, valor: valor, descricao: descricao, metadata: metadata, extRef: extRef, idemExtra: idemExtra, email: email, nome: nome, fone: fone, agora: agora, host: entrada.host, segredo: segredo }, deps);
  } finally { liberar(); if (travaCriacao.get(extRef) === fila) travaCriacao.delete(extRef); }
}

function respostaMP(pg, valor, descricao, segredo, agora) {
  const id = 'mp.' + pg.id;
  return { status: 200, corpo: { ok: true, modo: 'mp', id: id, token: util.tokenDe(id, segredo), valor: valor, descricao: descricao,
    copiaECola: pg.copiaECola, qrImagem: pg.qrImagem, expiraEm: pg.expiraEm || new Date(agora + mp.VALIDADE_MS).toISOString() } };
}

async function criarOuReusarMP(env, d, deps) {
  const c = d.c, valor = d.valor, agora = d.agora;
  /* D2: a mesma reserva (mesma referência) não vira duas cobranças. Se a busca falhar, vende normalmente. */
  try {
    const achados = await mp.buscarPorReferencia(env, d.extRef, deps);
    const pago = achados.find(function (x) { return x.status === 'approved'; });
    if (pago) { util.log('pix_ja_pago', { origem: c.origem, pagamento: pago.id }); return erro(409, 'ja_pago', 'esta reserva ja tem um pagamento aprovado', { numero: pago.id, valor: pago.valor }); }
    for (const x of achados) {
      if (x.status !== 'pending' && x.status !== 'in_process' && x.status !== 'authorized') continue;
      if (mp.mapearStatus(x, agora) !== 'pendente' || cents(x.valor) !== cents(valor)) continue;
      let pg = x;
      if (!pg.copiaECola) { try { pg = (await mp.buscarPagamento(env, x.id, deps)) || x; } catch (e) { pg = x; } }
      if (!pg.copiaECola) continue;
      util.log('pix_reaproveitado', { origem: c.origem, valor: valor, pagamento: pg.id, fone: d.fone });
      return respostaMP(pg, valor, d.descricao, d.segredo, agora);
    }
  } catch (e) { util.log('mp_busca_referencia_falhou', { msg: String(e.message), status: e.status }, 'erro'); }
  let pg;
  try {
    pg = await mp.criarPix(env, { valor: valor, descricao: d.descricao, tentativa: c.tentativa, idemExtra: d.idemExtra, email: d.email, nome: d.nome, externalReference: d.extRef, metadata: d.metadata,
      notificationUrl: urlWebhook(env, d.host), agora: agora }, deps);
  } catch (e) {
    util.log('mp_criar_falhou', { msg: String(e.message), status: e.status }, 'erro');
    return indisponivel('Mercado Pago nao respondeu');
  }
  /* a chave repetida devolve a cobrança antiga como ela está: paga = ja_pago; cancelada ou vencida (D9) nunca volta para a tela */
  if (pg.status === 'approved') { util.log('pix_ja_pago', { origem: c.origem, pagamento: pg.id }); return erro(409, 'ja_pago', 'esta tentativa ja foi paga', { numero: pg.id, valor: pg.valor }); }
  if (mp.mapearStatus(pg, agora) !== 'pendente') {
    util.log('mp_cobranca_encerrada', { status: pg.status, pagamento: pg.id }, 'erro');
    return indisponivel('Mercado Pago devolveu cobranca encerrada');
  }
  if (cents(pg.valor) !== cents(valor)) {     /* o MP devolveu outra cobrança (ex.: chave repetida): não entrega esse Pix */
    util.log('mp_valor_divergente', { esperado: valor, devolvido: pg.valor, pagamento: pg.id }, 'erro');
    return indisponivel('Mercado Pago devolveu cobranca de outro valor');
  }
  util.log('pix_criado', { modo: 'mp', origem: c.origem, valor: valor, pagamento: pg.id, fone: d.fone });
  return respostaMP(pg, valor, d.descricao, d.segredo, agora);
}

/* ---------- GET /api/pix-status/?id=&token= ---------- */
async function pixStatus(entrada, env, deps) {
  const id = entrada.query.id, token = entrada.query.token;
  const prefixo = typeof id === 'string' ? (id.indexOf('sim.') === 0 ? 'sim.' : id.indexOf('mp.') === 0 ? 'mp.' : '') : '';
  if (prefixo === 'sim.' && env.SITE_TESTE !== '1') return indisponivel();
  if (prefixo === 'mp.' && !env.MP_ACCESS_TOKEN) return indisponivel();
  const segredo = util.segredoPix(env);
  if (!segredo) return indisponivel();
  if (!id || id.length > 512 || !util.tokenConfere(id, token, segredo)) return erro(403, 'token_invalido', 'token ausente ou errado');
  const agora = agoraDe(deps);

  if (prefixo === 'sim.') {
    const d = util.lerObjetoAssinado(id.slice(4), segredo);
    if (!d) return erro(404, 'nao_encontrado', 'id desconhecido');
    const simular = entrada.query.simular;
    let status = 'pendente', manual = false;
    if (canceladosSim.has(id)) status = 'recusado';     /* D9: cancelado não volta a ser pagável, nem simulando (como no Mercado Pago) */
    else if (simular === 'aprovado') status = 'aprovado';
    else if (simular === 'manual') { status = 'aprovado'; manual = true; }
    else if (simular === 'recusado') status = 'recusado';
    else if (simular === 'estornado') status = 'estornado';
    else if (simular === 'expirado' || agora > new Date(d.e).getTime()) status = 'expirado';
    const corpo = { ok: true, modo: 'simulado', status: status, valor: d.v, numero: d.n, pagoEm: status === 'aprovado' ? new Date(agora).toISOString() : null, expiraEm: d.e, tagme: null };
    /* pagamento simulado NUNCA chama o TagMe, nem com TAGME_PARTNER_APP_ID presente e reserva real na ref */
    if (d.o === 'tagme' && d.t && status === 'aprovado')
      corpo.tagme = manual ? { estado: 'pendente_manual', codigo: d.t.codigo, dia: d.t.dia, hora: null, pessoas: d.t.pessoas, simulado: true }
        : { estado: 'confirmada', codigo: d.t.codigo, dia: d.t.dia, hora: d.t.hora || '19:00', pessoas: d.t.pessoas, simulado: true };
    return { status: 200, corpo: corpo };
  }
  if (prefixo !== 'mp.') return erro(404, 'nao_encontrado', 'id desconhecido');
  let pg;
  try { pg = await mp.buscarPagamento(env, id.slice(3), deps); }
  catch (e) { util.log('mp_busca_falhou', { msg: String(e.message), status: e.status }, 'erro'); return indisponivel('Mercado Pago nao respondeu'); }
  if (!pg) return erro(404, 'nao_encontrado', 'pagamento nao existe');
  const status = mp.mapearStatus(pg, agora);
  const corpo = { ok: true, modo: 'mp', status: status, valor: pg.valor, numero: pg.id, pagoEm: pg.pagoEm, expiraEm: pg.expiraEm, tagme: null };
  const m = pg.metadata || {};
  if (m.origem === 'tagme' && status === 'aprovado') corpo.tagme = await confirmarNoTagme(env, metaTagme(m), deps);
  return { status: 200, corpo: corpo };
}
function metaTagme(m) {
  return { reservaId: m.reserva_id, fone: String(m.fone || ''), dia: m.dia, pessoas: Number(m.pessoas), piso: Number(m.piso), codigo: m.codigo, hora: m.hora || null, sim: m.reserva_sim === '1' };
}

/* ---------- POST /api/pix-cancelar/  { id, token } ----------
   D9: a tela largou este Pix (a pessoa mudou a reserva, preferiu o WhatsApp ou começou outra). Enquanto
   pendente, ele ainda podia ser pago sem nenhuma tela acompanhar: cancela no Mercado Pago. É também a
   última conferência: se já foi pago, 409 ja_pago com o número e o valor, e a tela mostra o pagamento.
   Respostas: 200 { status: "cancelado" } ou, se já tinha acabado, { status: "expirado" | "recusado" | "estornado" }. */
const jaPagoDe = (numero, valor) => erro(409, 'ja_pago', 'este Pix ja foi pago', { numero: String(numero), valor: valor });
async function pixCancelar(entrada, env, deps) {
  const c = entrada.corpo && typeof entrada.corpo === 'object' ? entrada.corpo : {};
  const id = c.id, token = c.token;
  const prefixo = typeof id === 'string' ? (id.indexOf('sim.') === 0 ? 'sim.' : id.indexOf('mp.') === 0 ? 'mp.' : '') : '';
  if (prefixo === 'sim.' && env.SITE_TESTE !== '1') return indisponivel();
  if (prefixo === 'mp.' && !env.MP_ACCESS_TOKEN) return indisponivel();
  const segredo = util.segredoPix(env);
  if (!segredo) return indisponivel();
  if (!id || id.length > 512 || !util.tokenConfere(id, token, segredo)) return erro(403, 'token_invalido', 'token ausente ou errado');
  const agora = agoraDe(deps);

  if (prefixo === 'sim.') {
    const d = util.lerObjetoAssinado(id.slice(4), segredo);
    if (!d) return erro(404, 'nao_encontrado', 'id desconhecido');
    /* só no modo simulado: o painel de teste pode dizer que o Pix descartado já tinha sido pago */
    if (c.simular === 'aprovado' || c.simular === 'manual') return jaPagoDe(d.n, d.v);
    canceladosSim.add(id);
    if (canceladosSim.size > 1000) canceladosSim.delete(canceladosSim.values().next().value);
    [cacheSimulado, cacheSimuladoRef].forEach(function (m) { m.forEach(function (v, k) { if (v.id === id) m.delete(k); }); });
    util.log('pix_cancelado', { modo: 'simulado' });
    return { status: 200, corpo: { ok: true, modo: 'simulado', status: 'cancelado' } };
  }
  if (prefixo !== 'mp.') return erro(404, 'nao_encontrado', 'id desconhecido');
  const num = id.slice(3);
  const final = pg => {
    if (pg.status === 'approved') return jaPagoDe(pg.id, pg.valor);
    const st = mp.mapearStatus(pg, agora);
    return st === 'pendente' ? null : { status: 200, corpo: { ok: true, modo: 'mp', status: pg.status === 'cancelled' && pg.statusDetail !== 'expired' ? 'cancelado' : st } };
  };
  let pg;
  try { pg = await mp.buscarPagamento(env, num, deps); }
  catch (e) { util.log('mp_busca_falhou', { msg: String(e.message), status: e.status }, 'erro'); return indisponivel('Mercado Pago nao respondeu'); }
  if (!pg) return erro(404, 'nao_encontrado', 'pagamento nao existe');
  const antes = final(pg);
  if (antes) return antes;
  try { pg = await mp.cancelarPagamento(env, num, deps); }
  catch (e) {
    /* recusou: pode ter sido pago no mesmo instante. Busca de novo e responde o que estiver lá */
    util.log('mp_cancelar_falhou', { msg: String(e.message), status: e.status }, 'erro');
    try { pg = await mp.buscarPagamento(env, num, deps); } catch (e2) { pg = null; }
    const depois = pg && final(pg);
    return depois || indisponivel('Mercado Pago nao cancelou');
  }
  if (!pg) return erro(404, 'nao_encontrado', 'pagamento nao existe');
  if (pg.status !== 'cancelled') return final(pg) || indisponivel('Mercado Pago nao cancelou');
  util.log('pix_cancelado', { modo: 'mp', pagamento: pg.id });
  return { status: 200, corpo: { ok: true, modo: 'mp', status: 'cancelado' } };
}

/* ---------- POST /api/mp-webhook/ ---------- */
async function mpWebhook(entrada, env, deps) {
  const h = entrada.headers || {};
  const corpo = entrada.corpo && typeof entrada.corpo === 'object' ? entrada.corpo : {};
  const dataId = entrada.query['data.id'] || (corpo.data && corpo.data.id) || '';
  const valida = mp.validarAssinaturaWebhook(env.MP_WEBHOOK_SECRET, { xSignature: h['x-signature'], xRequestId: h['x-request-id'], dataId: entrada.query['data.id'] || dataId });
  if (!valida) { util.log('webhook_recusado', { motivo: 'assinatura' }); return erro(401, 'assinatura_invalida', 'assinatura ausente ou invalida'); }
  const tipo = entrada.query.type || entrada.query.topic || corpo.type || corpo.topic;
  if (tipo !== 'payment' || !dataId) return { status: 200, corpo: { ok: true, ignorado: true } };
  if (!env.MP_ACCESS_TOKEN) return indisponivel();
  let pg;
  try { pg = await mp.buscarPagamento(env, dataId, deps); }
  catch (e) { util.log('webhook_mp_falhou', { msg: String(e.message) }, 'erro'); return indisponivel('Mercado Pago nao respondeu'); }   /* 503: o Mercado Pago tenta de novo */
  if (!pg) return { status: 200, corpo: { ok: true, ignorado: true } };
  const status = mp.mapearStatus(pg, agoraDe(deps));
  let tm = null;
  if (status === 'aprovado' && pg.metadata && pg.metadata.origem === 'tagme') tm = await confirmarNoTagme(env, metaTagme(pg.metadata), deps);
  util.log('webhook_ok', { pagamento: pg.id, status: status, tagme: tm && tm.estado });
  return { status: 200, corpo: { ok: true, status: status } };
}

module.exports = { tagmeReserva, pixCriar, pixStatus, pixCancelar, mpWebhook, modoMP, modoTagme, confirmarNoTagme };
