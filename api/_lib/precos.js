/* PREÇOS NO SERVIDOR (fase 2).
   Mudou preço ou regra em reserva/index.html? Mude aqui também e rode
   `node review/testes-pix/roda-tudo.js` (o teste de paridade falha se os dois divergirem).

   Porte fiel do script da página (TABELA, FERIADOS, faixa, promoção, boliche,
   aniversário, sinal). Todas as datas são dia civil (sem fuso): usamos o número
   do dia desde 1970 em UTC, nunca a hora local do servidor. */
'use strict';

var TABELA = {
  1: { terQui: { pix: 54.99, maquina: 59.99, promo: 49.99 },
       sexDom: { pix: 59.99, maquina: 64.99 },
       sabado: { pix: 64.99, maquina: 69.99 },
       crianca: { c35: 19.99, c68: 34.99 } },
  2: { terQui: { pix: 69.99, maquina: 74.99 },
       sexDom: { pix: 79.99, maquina: 84.99 },
       crianca: { c35: 24.99, c68: 34.99 } }
};
var PISTA = { rodizio: { util: 80, fim: 120 }, avulso: { util: 200, fim: 300 }, promo18: 40, maxPistas: 4 };
var FERIADOS = ['01-01', '04-21', '04-23', '05-01', '06-13', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'];
var KIT = { nome: 'Kit Festa + Bolo', preco: 119.99, max: 1 };

/* ---------- datas civis ---------- */
function dn(y, m, d) { return Math.round(Date.UTC(y, m - 1, d) / 86400000); }
function civil(n) {
  var t = new Date(n * 86400000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), n: n, w: t.getUTCDay() };
}
function parseData(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  var y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  var c = civil(dn(y, m, d));
  if (c.y !== y || c.m !== m || c.d !== d) return null;
  return c;
}
function doisDig(n) { return ('0' + n).slice(-2); }
function pascoaN(ano) {
  var a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4,
      f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30,
      i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
      n = h + l - 7 * m + 114;
  return dn(ano, Math.floor(n / 31), (n % 31) + 1);
}
function feriado(c) {
  if (FERIADOS.indexOf(doisDig(c.m) + '-' + doisDig(c.d)) >= 0) return true;
  var dif = c.n - pascoaN(c.y);
  return dif === -47 || dif === -2;
}
function vespera(c) { return feriado(civil(c.n + 1)); }
function especial(c) { return !!c && (feriado(c) || vespera(c)); }
function diaUtil(c) {
  if (!c) return true;
  return c.w >= 2 && c.w <= 4 && !especial(c);
}
function faixa(c, piso) {
  if (piso === 1 && c && c.w === 6) return 'sabado';
  return diaUtil(c) ? 'terQui' : 'sexDom';
}
function temPromo(c, piso, hoje) {
  return piso === 1 && !!c && diaUtil(c) && (c.n - hoje.n) >= 7;
}
function arred(v) { return Math.round(v * 100 + 1e-6) / 100; }
function moeda(v) { return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function textoSinal(n) { return n + (n > 1 ? ' rodízios antecipados' : ' rodízio antecipado'); }
function nomeSinal(n) { return 'Antecipação de ' + textoSinal(n).replace(' antecipados', '').replace(' antecipado', ''); }

/* ---------- validação ---------- */
function inteiro(v, min, max) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= min && v <= max; }

/* Devolve { ok:true, p, data } com o pedido normalizado, ou { ok:false, mensagem }. */
function validarPedido(pedido, hojeSP) {
  var hoje = parseData(hojeSP);
  if (!hoje) return { ok: false, mensagem: 'hoje invalido' };
  if (!pedido || typeof pedido !== 'object') return { ok: false, mensagem: 'pedido ausente' };
  if (pedido.tipo === 'festa') return { ok: false, mensagem: 'festa e orcamento, sem Pix' };
  if (pedido.tipo !== 'mesa' && pedido.tipo !== 'pista') return { ok: false, mensagem: 'tipo invalido' };
  var tipo = pedido.tipo;
  if (!(tipo === 'mesa' ? (pedido.piso === 1 || pedido.piso === 2) : (pedido.piso === 0 || pedido.piso === 1 || pedido.piso === 2)))
    return { ok: false, mensagem: 'piso invalido' };
  var data = parseData(pedido.data);
  if (!data) return { ok: false, mensagem: 'data invalida' };
  if (data.n < hoje.n) return { ok: false, mensagem: 'data no passado' };
  if (data.n - hoje.n > 400) return { ok: false, mensagem: 'data longe demais' };
  var hora = null;
  if (pedido.hora !== null && pedido.hora !== undefined) {
    if (typeof pedido.hora !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(pedido.hora)) return { ok: false, mensagem: 'hora invalida' };
    hora = pedido.hora;
  }
  var n = {}, campos = { adultos: 100, bari: 100, c35: 100, c68: 100, bebes: 100 };
  for (var k in campos) {
    var v = pedido[k] === undefined ? 0 : pedido[k];
    if (!inteiro(v, 0, campos[k])) return { ok: false, mensagem: k + ' invalido' };
    n[k] = v;
  }
  if (n.adultos + n.bari + n.c35 + n.c68 + n.bebes > 200) return { ok: false, mensagem: 'grupo grande demais' };
  var pistas = pedido.pistas === undefined ? 1 : pedido.pistas, horas = pedido.horas === undefined ? 1 : pedido.horas;
  if (tipo === 'pista') {
    if (!inteiro(pistas, 1, PISTA.maxPistas)) return { ok: false, mensagem: 'pistas invalido' };
    var H0 = parseInt(hora || '18', 10);
    if (!inteiro(horas, 1, Math.max(1, Math.min(3, 23 - H0)))) return { ok: false, mensagem: 'horas invalido' };
  } else { pistas = 1; horas = 1; }
  var exclusiva = pedido.exclusiva === true;
  if (pedido.exclusiva !== undefined && typeof pedido.exclusiva !== 'boolean') return { ok: false, mensagem: 'exclusiva invalido' };
  var aniv = { on: false, dia: 0, mes: 0, quem: 'adultos' };
  if (pedido.aniv && typeof pedido.aniv === 'object' && pedido.aniv.on === true) {
    if (!inteiro(pedido.aniv.dia, 1, 31) || !inteiro(pedido.aniv.mes, 1, 12)) return { ok: false, mensagem: 'aniversario invalido' };
    var quem = pedido.aniv.quem === undefined ? 'adultos' : pedido.aniv.quem;
    if (['adultos', 'bari', 'c35', 'c68'].indexOf(quem) < 0) return { ok: false, mensagem: 'aniversariante invalido' };
    aniv = { on: true, dia: pedido.aniv.dia, mes: pedido.aniv.mes, quem: quem };
  }
  var kit = 0;
  if (pedido.extras && typeof pedido.extras === 'object' && pedido.extras.kit !== undefined) {
    if (!inteiro(pedido.extras.kit, 0, KIT.max)) return { ok: false, mensagem: 'kit invalido' };
    kit = pedido.extras.kit;
  }
  var avulso = tipo === 'pista' && !pedido.piso;
  if (kit && data.w === 6) return { ok: false, mensagem: 'kit nao vale aos sabados' };
  var p = { tipo: tipo, piso: pedido.piso, hora: hora, adultos: n.adultos, bari: n.bari, c35: n.c35, c68: n.c68, bebes: n.bebes,
            pistas: pistas, horas: horas, exclusiva: exclusiva, aniv: aniv, kit: avulso ? 0 : kit };
  return { ok: true, p: p, data: data, hoje: hoje };
}

/* ---------- cálculo (espelho do agora()/total() da página) ---------- */
function calcular(pedido, hojeSP) {
  var v = validarPedido(pedido, hojeSP);
  if (!v.ok) { var e = new Error(v.mensagem); e.codigo = 'dados_invalidos'; throw e; }
  var st = v.p, d = v.data, hoje = v.hoje;
  var comRodizio = st.tipo === 'mesa' || (st.tipo === 'pista' && st.piso > 0);
  var avulso = st.tipo === 'pista' && !st.piso;
  function valorDia(forma) { return TABELA[st.piso][faixa(d, st.piso)][forma || 'pix']; }

  /* aniversário */
  function distAniv() {
    var menor = 999;
    [-1, 0, 1].forEach(function (k) {
      var a = Math.round(Date.UTC(d.y + k, st.aniv.mes - 1, st.aniv.dia) / 86400000);
      menor = Math.min(menor, Math.abs(a - d.n));
    });
    return menor;
  }
  function anivRegra() {
    if (!st.aniv.on || !comRodizio || !st.aniv.dia) return '';
    var w = d.w, dist = distAniv();
    var pagantes = st.adultos + st.bari - 1 + st.c35 + st.c68;
    if (pagantes >= 10 && (dist === 0 || ((w === 3 || w === 4) && dist <= 5))) return 'gratis';
    return dist === 0 ? 'meia' : 'fora';
  }
  function quemAniv() {
    var ok = ['adultos', 'bari', 'c35', 'c68'].filter(function (k) { return st[k] > 0; });
    return ok.indexOf(st.aniv.quem) >= 0 ? st.aniv.quem : ok[0];
  }
  function anivComDesconto() { var r = anivRegra(); return r === 'gratis' || r === 'meia'; }
  function antecipaveis() {
    var a = st.adultos, b = st.bari;
    if (anivComDesconto()) { if (quemAniv() === 'adultos') a--; else if (quemAniv() === 'bari') b--; }
    return { adultos: Math.max(0, a), bari: Math.max(0, b) };
  }
  function qtdAntecipaveis() { var x = antecipaveis(); return x.adultos + x.bari; }
  function pessoas() { return st.adultos + st.bari + st.c35 + st.c68 + st.bebes; }
  function rodiziosDoSinal() {
    var p = pessoas(), n = p < 20 ? 1 : Math.floor(p / 10);
    return Math.min(n, qtdAntecipaveis());
  }
  function sinalCobreTodos() { var q = qtdAntecipaveis(); return q > 0 && rodiziosDoSinal() >= q; }
  function pagaTudo() { return comRodizio && (st.exclusiva || sinalCobreTodos()); }
  function usaPromo() { return pagaTudo() && comRodizio && temPromo(d, st.piso, hoje); }
  function valorSinal() {
    var n = rodiziosDoSinal(), cheio = valorDia(), x = antecipaveis(), u = [], i;
    for (i = 0; i < x.adultos; i++) u.push(cheio);
    for (i = 0; i < x.bari; i++) u.push(arred(cheio * 0.7));
    u.sort(function (a, b) { return b - a; });
    return arred(u.slice(0, n).reduce(function (s, q) { return s + q; }, 0));
  }
  function linhasRodizio(promo) {
    var cheio = valorDia(), va = promo ? TABELA[1].terQui.promo : cheio;
    var vb = Math.min(va, arred(cheio * 0.7));
    var x = antecipaveis(), out = [];
    if (x.adultos) out.push({ nome: x.adultos + ' adulto' + (x.adultos > 1 ? 's' : '') + ' × ' + moeda(va), valor: va * x.adultos });
    if (x.bari) out.push({ nome: x.bari + ' bariátrico' + (x.bari > 1 ? 's' : '') + ' × ' + moeda(vb), valor: vb * x.bari });
    return out;
  }
  /* boliche */
  function promoNaHora(h) { return !!st.piso && h === 0 && st.hora === '18:00'; }
  function meiaNaHora(h) { return !!st.piso && diaUtil(d) && h === (promoNaHora(0) ? 2 : 1); }
  function precoPista(h) {
    var util = diaUtil(d);
    if (!st.piso) return util ? PISTA.avulso.util : PISTA.avulso.fim;
    if (promoNaHora(h)) return PISTA.promo18;
    if (meiaNaHora(h)) return PISTA.rodizio.util / 2;
    return util ? PISTA.rodizio.util : PISTA.rodizio.fim;
  }
  function linhasPista() {
    var out = [], H = parseInt(st.hora || '18', 10);
    for (var h = 0; h < st.horas; h++) {
      var p = precoPista(h), tag = '';
      if (promoNaHora(h)) tag = ' (promoção)';
      else if (meiaNaHora(h)) tag = ' (50%)';
      out.push({ nome: (st.pistas > 1 ? st.pistas + ' pistas às ' : 'Pista às ') + (H + h) + 'h' + tag, valor: p * st.pistas });
    }
    return out;
  }

  var out = [];
  if (comRodizio) {
    if (pagaTudo()) out = out.concat(linhasRodizio(usaPromo()));
    else out.push({ nome: nomeSinal(rodiziosDoSinal()), valor: valorSinal() });
  }
  if (st.tipo === 'pista') out = out.concat(linhasPista());
  if (!avulso && st.kit) out.push({ nome: (st.kit > 1 ? st.kit + '× ' : '') + KIT.nome, valor: KIT.preco * st.kit, extra: true });

  var total = arred(out.reduce(function (s, i) { return s + i.valor; }, 0));
  if (!(total > 0)) { var e2 = new Error('total zerado'); e2.codigo = 'dados_invalidos'; throw e2; }
  var descricao = out.length === 1 ? out[0].nome : ('Reserva Santo Strike: ' + out.map(function (l) { return l.nome; }).join('; '));
  if (descricao.length > 240) descricao = descricao.slice(0, 237) + '...';
  return { linhas: out, total: total, descricao: descricao };
}

/* ---------- sinal de uma reserva que já existe no TagMe ---------- */
function sinalTagme(o) {
  var c = parseData(o && o.dia);
  var pessoas = o && o.pessoas, piso = o && o.piso;
  if (!c || !inteiro(pessoas, 1, 500) || (piso !== 1 && piso !== 2)) {
    var e = new Error('dados do sinal invalidos'); e.codigo = 'dados_invalidos'; throw e;
  }
  var rodizios = pessoas < 20 ? 1 : Math.floor(pessoas / 10);
  var valor = arred(TABELA[piso][faixa(c, piso)].pix * rodizios);
  return { rodizios: rodizios, valor: valor, descricao: nomeSinal(rodizios) };
}

/* para o log e para a validação de datas nas rotas */
function validarDiaFuturo(dia, hojeSP) {
  var c = parseData(dia), h = parseData(hojeSP);
  return !!c && !!h && c.n >= h.n && c.n - h.n <= 400;
}

module.exports = { calcular: calcular, sinalTagme: sinalTagme, validarPedido: validarPedido, parseData: parseData, validarDiaFuturo: validarDiaFuturo,
                   TABELA: TABELA, arred: arred };
