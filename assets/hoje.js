/* Reserva para hoje do Santo Strike: horário, limite e estado do dia.
   Fonte única para a home, a reserva de 8 passos e a página /reserva/hoje/.

   É AQUI QUE SE MUDA O HORÁRIO E O LIMITE DA RESERVA PARA HOJE.
   O que cada linha do CONFIG faz:
     teste     true no site de teste: mostra o selo, deixa simular a hora e o dia
               e põe "TESTE" no começo da mensagem do WhatsApp. No site oficial, false.
     abre      hora em que a reserva para hoje abre, 'HH:MM' (09:00, definido pela casa em 04/11/2026).
     fecha     hora em que ela encerra, 'HH:MM' (15:30). Às 15:30 já está encerrada.
     limite    máximo de pessoas pela reserva online. Acima disso, WhatsApp.
     tz        fuso usado para saber que dia e que hora são. Sempre o de São Paulo,
               nunca o do aparelho de quem abre o site.
     widget    endereço da reserva do TagMe que aparece dentro da página.
     link      o mesmo TagMe em outra aba, para quando a reserva dentro da página não carrega.
     whatsapp  número da casa, só dígitos, com 55 e DDD.
     abreExtra datas 'AAAA-MM-DD' de segunda ou de 3º domingo em que a casa abre
               (ex.: ['2026-10-12']). Fora dessas datas, segunda e 3º domingo ficam fechados.

   Script clássico, sem módulo. Carregue SEM defer no <head>:
     <script src="/assets/hoje.js"></script>
   O que ele expõe em window.SantoHoje está descrito em
   notas-time/2026-11-04-site-teste-tagme.md (contrato entre as frentes). */
(function (w) {
  'use strict';

  var CONFIG = {
    teste: true,          // site de teste: selo, hora simulada e prefixo TESTE no WhatsApp
    abre: '09:00',        // a casa, 04/11/2026: a reserva do dia abre às 9h
    fecha: '15:30',       // e encerra às 15h30
    limite: 21,           // a casa, 04/11/2026: até 21 pessoas pela reserva online
    tz: 'America/Sao_Paulo',
    widget: 'https://reservation-widget.tagme.com.br/reservation/schedule/66392cc1bf16af005b855193/reservationWidget',
    link: 'https://usetag.me/santostrike',
    whatsapp: '5521988799699',
    abreExtra: []         // 'AAAA-MM-DD' de segunda ou 3º domingo em que a casa abre
  };

  var CHAVE_HORA = 'santoHojeHora';
  var CHAVE_DIA = 'santoHojeDia';
  var PREFIXO = '*TESTE: site de teste, não é uma reserva de verdade*\n\n';

  var api = { CONFIG: CONFIG };
  var cfg = function () { return api.CONFIG || CONFIG; };

  /* ---------- validação ---------- */
  var RE_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;
  var RE_DIA = /^(\d{4})-(\d{2})-(\d{2})$/;
  function horaValida(h) { return typeof h === 'string' && RE_HORA.test(h); }
  /* data que existe no calendário (2026-02-30 não passa) */
  function diaValido(d) {
    var m = typeof d === 'string' && RE_DIA.exec(d);
    if (!m) return false;
    var a = +m[1], me = +m[2], di = +m[3];
    if (a < 1900 || a > 2999 || me < 1 || me > 12 || di < 1) return false;
    var t = new Date(Date.UTC(a, me - 1, di));
    return t.getUTCFullYear() === a && t.getUTCMonth() === me - 1 && t.getUTCDate() === di;
  }
  function minutosDe(h) { var p = String(h).split(':'); return (+p[0]) * 60 + (+p[1]); }
  /* '15:30' vira '15h30' e '18:00' vira '18h', como se escreve no Brasil */
  function fmtHora(h) { var p = String(h).split(':'); return (+p[0]) + 'h' + (p[1] === '00' ? '' : p[1]); }
  /* 0 = domingo, calculado pela própria data (não depende do fuso do aparelho) */
  function diaDaSemana(data) {
    var p = data.split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();
  }
  var dois = function (n) { return (n < 10 ? '0' : '') + n; };

  /* ---------- sessionStorage: o modo privado pode lançar erro ---------- */
  function ler(k) { try { return w.sessionStorage.getItem(k); } catch (e) { return null; } }
  function gravar(k, v) {
    try {
      if (v == null) w.sessionStorage.removeItem(k);
      else w.sessionStorage.setItem(k, v);
    } catch (e) {}
  }

  /* a simulação fica em memória também, para funcionar mesmo sem sessionStorage */
  var sim = { hora: null, dia: null };
  (function () {
    var h = ler(CHAVE_HORA), d = ler(CHAVE_DIA);
    if (horaValida(h)) sim.hora = h;
    if (diaValido(d)) sim.dia = d;
  })();

  /* ---------- relógio no fuso de São Paulo ---------- */
  var formatos = {};
  function relogio() {
    var tz = cfg().tz || 'America/Sao_Paulo';
    var agoraMs = Date.now();
    try {
      var f = formatos[tz] || (formatos[tz] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }));
      var p = {};
      f.formatToParts(new Date(agoraMs)).forEach(function (x) { p[x.type] = x.value; });
      var hora = (+p.hour) % 24;     /* alguns navegadores escrevem meia-noite como 24 */
      return { data: p.year + '-' + p.month + '-' + p.day, minutos: hora * 60 + (+p.minute) };
    } catch (e) {
      /* navegador sem fuso no Intl: São Paulo está em UTC-3 o ano todo desde 2019 */
      var t = new Date(agoraMs - 3 * 3600000);
      return {
        data: t.getUTCFullYear() + '-' + dois(t.getUTCMonth() + 1) + '-' + dois(t.getUTCDate()),
        minutos: t.getUTCHours() * 60 + t.getUTCMinutes()
      };
    }
  }

  api.agora = function () {
    var r = relogio();
    var teste = !!cfg().teste;
    var h = teste ? sim.hora : null, d = teste ? sim.dia : null;
    var data = d || r.data;
    return {
      data: data,
      dia: diaDaSemana(data),
      minutos: h ? minutosDe(h) : r.minutos,
      simulado: !!(h || d)
    };
  };

  /* a casa fecha às segundas e no 3º domingo do mês (dias 15 a 21), salvo abreExtra */
  function fechadoEm(data, dia) {
    var extra = cfg().abreExtra || [];
    if (extra.indexOf(data) >= 0) return false;
    if (dia === 1) return true;
    var n = +data.slice(8, 10);
    return dia === 0 && n >= 15 && n <= 21;
  }

  api.estado = function () {
    var a = api.agora(), c = cfg();
    if (fechadoEm(a.data, a.dia)) return 'fechado';
    if (a.minutos < minutosDe(c.abre)) return 'antes';
    if (a.minutos < minutosDe(c.fecha)) return 'aberto';
    return 'encerrado';
  };

  api.texto = function () {
    var c = cfg();
    switch (api.estado()) {
      case 'fechado': return 'Hoje a casa está fechada.';
      case 'antes': return 'As reservas para hoje abrem às ' + fmtHora(c.abre) + '.';
      case 'aberto': return 'Reservas para hoje até as ' + fmtHora(c.fecha) + '.';
      default: return 'As reservas para hoje encerraram às ' + fmtHora(c.fecha) + '.';
    }
  };

  api.janela = function () { var c = cfg(); return fmtHora(c.abre) + ' às ' + fmtHora(c.fecha); };

  /* ---------- avisar quem depende do estado ---------- */
  /* Um relógio só (30 s) para todos os ouvintes. Ele avisa quando o estado muda.
     simular() e simularDia() sempre avisam, porque a data ou a hora mudaram mesmo
     que o estado continue o mesmo. Ao voltar da tela bloqueada, confere na hora. */
  var ouvintes = [];
  var ultimo = null;
  var timer = null;
  function avisar(e) {
    ouvintes.slice().forEach(function (fn) {
      try { fn(e); } catch (err) { setTimeout(function () { throw err; }, 0); }
    });
  }
  function conferir(sempre) {
    var e = api.estado();
    if (sempre || e !== ultimo) { ultimo = e; avisar(e); }
  }
  api.aoMudar = function (fn) {
    if (typeof fn !== 'function') return;
    ouvintes.push(fn);
    if (ultimo === null) ultimo = api.estado();
    if (!timer) {
      timer = setInterval(function () { conferir(false); }, 30000);
      var doc = w.document;
      if (doc && doc.addEventListener) {
        doc.addEventListener('visibilitychange', function () {
          if (doc.visibilityState !== 'hidden') conferir(false);
        });
      }
      if (w.addEventListener) w.addEventListener('pageshow', function () { conferir(false); });
    }
  };

  /* ---------- simulação (só no site de teste) ---------- */
  api.simular = function (h) {
    if (!cfg().teste) return;
    if (h == null || h === '') { sim.hora = null; gravar(CHAVE_HORA, null); }
    else if (horaValida(h)) { sim.hora = h; gravar(CHAVE_HORA, h); }
    else return;
    conferir(true);
  };
  api.simularDia = function (d) {
    if (!cfg().teste) return;
    if (d == null || d === '') { sim.dia = null; gravar(CHAVE_DIA, null); }
    else if (diaValido(d)) { sim.dia = d; gravar(CHAVE_DIA, d); }
    else return;
    conferir(true);
  };
  api.simulando = function () {
    var teste = !!cfg().teste;
    return { hora: teste ? sim.hora : null, dia: teste ? sim.dia : null };
  };

  /* ---------- WhatsApp ---------- */
  Object.defineProperty(api, 'prefixoTeste', {
    enumerable: true,
    get: function () { return cfg().teste ? PREFIXO : ''; }
  });
  /* Mesma regra do linkWhatsApp() da reserva de 8 passos: no celular o link
     abre o aplicativo (wa.me); no computador abre o WhatsApp Web, porque o
     aplicativo do WhatsApp para Windows junta a mensagem numa linha só quando
     ela chega por link, e o Web mantém as quebras de linha. */
  function noCelular() {
    var n = w.navigator || {};
    return /Android|iPhone|iPad|iPod/i.test(n.userAgent || '') ||
           (n.maxTouchPoints > 1 && /Mac/.test(n.platform || ''));
  }
  api.zap = function (texto) {
    var num = cfg().whatsapp;
    var txt = encodeURIComponent(api.prefixoTeste + (texto == null ? '' : texto));
    return noCelular() ? 'https://wa.me/' + num + '?text=' + txt
                       : 'https://web.whatsapp.com/send?phone=' + num + '&text=' + txt;
  };

  /* ---------- ?hora=HH:MM e ?dia=AAAA-MM-DD na URL (só no site de teste) ---------- */
  function daUrl(nome) {
    var q = (w.location && w.location.search || '').replace(/^\?/, '');
    if (!q) return null;
    var partes = q.split('&');
    for (var i = 0; i < partes.length; i++) {
      var kv = partes[i].split('=');
      var k;
      try { k = decodeURIComponent(kv[0].replace(/\+/g, ' ')); } catch (e) { continue; }
      if (k !== nome) continue;
      try { return decodeURIComponent((kv[1] || '').replace(/\+/g, ' ')); } catch (e) { return null; }
    }
    return null;
  }
  if (CONFIG.teste) {
    var hUrl = daUrl('hora'), dUrl = daUrl('dia');
    if (horaValida(hUrl)) { sim.hora = hUrl; gravar(CHAVE_HORA, hUrl); }
    if (diaValido(dUrl)) { sim.dia = dUrl; gravar(CHAVE_DIA, dUrl); }
  }

  w.SantoHoje = api;
})(window);
