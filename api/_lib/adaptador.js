/* Adaptador fino entre a Vercel (req, res do Node) e as funções puras
   (entrada, env) -> { status, corpo }. O servidor local usa o mesmo adaptador. */
'use strict';
const util = require('./util');

const LIMITE_CORPO = 10 * 1024;

function enviar(res, status, corpo, extra) {
  const txt = JSON.stringify(corpo);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (extra) Object.keys(extra).forEach(function (k) { res.setHeader(k, extra[k]); });
  res.end(txt);
}
function erro(status, codigo, mensagem, extra) {
  return { status: status, corpo: Object.assign({ ok: false, erro: codigo, mensagem: mensagem }, extra || {}) };
}

/* lê o corpo (limite de 10 KB). Na Vercel o corpo JSON já vem em req.body; no servidor local lemos o fluxo. */
function lerCorpo(req) {
  return new Promise(function (resolve, reject) {
    let pronto;
    try { pronto = req.body; } catch (e) { return reject(Object.assign(new Error('json invalido'), { codigo: 'dados_invalidos' })); }
    if (pronto !== undefined) {
      const txt = typeof pronto === 'string' ? pronto : Buffer.isBuffer(pronto) ? pronto.toString('utf8') : JSON.stringify(pronto);
      if (Buffer.byteLength(txt) > LIMITE_CORPO) return reject(Object.assign(new Error('corpo grande demais'), { codigo: 'corpo_grande' }));
      if (typeof pronto === 'string') { try { return resolve(JSON.parse(pronto)); } catch (e) { return reject(Object.assign(new Error('json invalido'), { codigo: 'dados_invalidos' })); } }
      return resolve(Buffer.isBuffer(pronto) ? null : pronto);
    }
    const partes = []; let tam = 0, estourou = false;
    req.on('data', function (c) {
      if (estourou) return;
      tam += c.length;
      if (tam > LIMITE_CORPO) { estourou = true; reject(Object.assign(new Error('corpo grande demais'), { codigo: 'corpo_grande' })); return; }
      partes.push(c);
    });
    req.on('end', function () {
      if (estourou) return;
      const txt = Buffer.concat(partes).toString('utf8');
      if (!txt.trim()) return resolve(null);
      try { resolve(JSON.parse(txt)); } catch (e) { reject(Object.assign(new Error('json invalido'), { codigo: 'dados_invalidos' })); }
    });
    req.on('error', function () { reject(Object.assign(new Error('falha ao ler'), { codigo: 'dados_invalidos' })); });
  });
}

/* opcoes: { metodos: ['POST'], limite: { max, janelaMs, nome }, lerCorpo: bool, semOrigem: bool } */
function criarRota(funcao, opcoes) {
  const op = opcoes || {};
  return async function (req, res) {
    try {
      if (op.metodos && op.metodos.indexOf(req.method) < 0)
        return enviar(res, 405, erro(405, 'metodo_nao_permitido', 'use ' + op.metodos.join(' ou ')).corpo, { Allow: op.metodos.join(', ') });
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
      const origem = req.headers.origin;
      if (origem && !op.semOrigem) {
        let h = null;
        try { h = new URL(origem).host.toLowerCase(); } catch (e) { h = null; }
        if (!h || h !== host) { const r = erro(403, 'origem_invalida', 'origem diferente do site'); return enviar(res, r.status, r.corpo); }
      }
      const env = process.env;
      const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'sem-ip').split(',')[0].trim();
      if (op.limite) {
        const nomes = [].concat(op.limite.envMax);      /* aceita uma lista: vale a primeira variável definida */
        const max = Number(nomes.map(function (n) { return env[n]; }).find(function (v) { return v; })) || op.limite.max;
        if (!util.limitar(op.limite.nome + ':' + ip, max, op.limite.janelaMs)) {
          util.log('limite', { rota: op.limite.nome });
          const r = erro(429, 'muitas_tentativas', 'muitas chamadas; espere alguns minutos');
          return enviar(res, r.status, r.corpo, { 'Retry-After': String(Math.ceil(op.limite.janelaMs / 1000)) });
        }
      }
      let corpo = null;
      if (op.lerCorpo) {
        try { corpo = await lerCorpo(req); }
        catch (e) {
          const r = e.codigo === 'corpo_grande' ? erro(413, 'corpo_grande', 'corpo acima de 10 KB') : erro(400, 'dados_invalidos', 'json invalido');
          return enviar(res, r.status, r.corpo);
        }
      }
      const url = new URL(req.url, 'http://x');
      const query = {}; url.searchParams.forEach(function (v, k) { query[k] = v; });
      const r = await funcao({ metodo: req.method, corpo: corpo, query: query, headers: req.headers, ip: ip, host: host }, env, {});
      return enviar(res, r.status, r.corpo);
    } catch (e) {
      util.log('erro_interno', { msg: String(e && e.message) }, 'erro');
      return enviar(res, 500, erro(500, 'erro_interno', 'erro inesperado').corpo);
    }
  };
}

module.exports = { criarRota: criarRota, erro: erro, enviar: enviar, lerCorpo: lerCorpo };
