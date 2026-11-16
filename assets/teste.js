/* Santo Strike: selo "SITE DE TESTE" e painel para simular hora e data.
   Só age se assets/hoje.js existe e CONFIG.teste está ligado. Em janeiro,
   no site oficial, este arquivo não vai junto. Tudo é position:fixed: nada
   entra no fluxo da página. */
(function () {
  'use strict';
  var S = window.SantoHoje;
  if (!S || !S.CONFIG || !S.CONFIG.teste) return;
  var doc = document;
  if (doc.getElementById('stTesteSelo')) return;

  var css = [
    '.st-teste-selo{position:fixed;left:10px;bottom:10px;z-index:2147483000;display:inline-flex;align-items:center;gap:.4rem;',
    'min-height:30px;padding:.25rem .65rem;border:1px solid #E3B23C;border-radius:999px;background:#150F0A;color:#E3B23C;',
    'font:700 .62rem/1 "DM Sans",system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;',
    'box-shadow:0 2px 10px rgba(0,0,0,.5);-webkit-tap-highlight-color:transparent;opacity:.92}',
    '.st-teste-selo:hover,.st-teste-selo[aria-expanded="true"]{opacity:1;background:#2a1d10}',
    '.st-teste-selo:focus-visible{outline:2px solid #F6F1E6;outline-offset:2px}',
    '.st-teste-selo i{width:7px;height:7px;border-radius:50%;background:#E3B23C;display:inline-block}',
    '.st-teste-selo.st-teste-sim i{background:#ff7a59}',
    '.st-teste-painel{position:fixed;left:10px;bottom:48px;z-index:2147483001;width:min(340px,calc(100vw - 20px));max-height:calc(100vh - 70px);overflow:auto;',
    'padding:1rem;border:1px solid rgba(227,178,60,.6);border-radius:14px;background:#150F0A;color:#F6F1E6;',
    'font:400 .85rem/1.5 "DM Sans",system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.65)}',
    '.st-teste-painel[hidden]{display:none}',
    '.st-teste-painel h2{margin:0 0 .5rem;font:700 .8rem/1.2 "DM Sans",system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;color:#E3B23C}',
    '.st-teste-painel p{margin:0 0 .7rem}',
    '.st-teste-estado{padding:.55rem .7rem;border-radius:10px;background:rgba(227,178,60,.1);border:1px solid rgba(227,178,60,.3)}',
    '.st-teste-estado small{display:block;margin-top:.15rem;color:rgba(246,241,230,.7);font-size:.75rem}',
    '.st-teste-grade{display:grid;grid-template-columns:1fr 1fr;gap:.45rem;margin:0 0 .6rem}',
    '.st-teste-painel button{font:600 .78rem/1.2 "DM Sans",system-ui,sans-serif;min-height:40px;padding:.4rem .5rem;border-radius:10px;',
    'border:1px solid rgba(246,241,230,.3);background:transparent;color:#F6F1E6;cursor:pointer}',
    '.st-teste-painel button:hover{border-color:#E3B23C}',
    '.st-teste-painel button:focus-visible{outline:2px solid #E3B23C;outline-offset:2px}',
    '.st-teste-painel button[aria-pressed="true"]{background:#E3B23C;color:#150F0A;border-color:#E3B23C}',
    '.st-teste-painel .st-teste-fechar{width:100%;margin-top:.2rem;border-color:#E3B23C;color:#E3B23C}',
    /* fase 2: pagamento simulado (só nas páginas com o /assets/pix.js) */
    '.st-teste-pix{margin:.4rem 0 .7rem;padding-top:.8rem;border-top:1px solid rgba(227,178,60,.3)}',
    '.st-teste-pix .st-teste-grade button:last-child:nth-child(odd){grid-column:1 / -1}',
    '.st-teste-painel label{display:block;margin:0 0 .6rem;font-size:.8rem;color:rgba(246,241,230,.85)}',
    '.st-teste-painel select{display:block;width:100%;min-height:40px;margin-top:.3rem;padding:.4rem .5rem;border-radius:10px;',
    'border:1px solid rgba(246,241,230,.3);background:#0B0705;color:#F6F1E6;font:600 .8rem/1.2 "DM Sans",system-ui,sans-serif;cursor:pointer}',
    '.st-teste-painel select:hover{border-color:#E3B23C}',
    '.st-teste-painel select:focus-visible{outline:2px solid #E3B23C;outline-offset:2px}'
  ].join('');
  var st = doc.createElement('style');
  st.id = 'stTesteCss';
  st.textContent = css;
  doc.head.appendChild(st);

  var selo = doc.createElement('button');
  selo.type = 'button';
  selo.id = 'stTesteSelo';
  selo.className = 'st-teste-selo';
  selo.setAttribute('aria-expanded', 'false');
  selo.setAttribute('aria-controls', 'stTestePainel');
  selo.setAttribute('aria-label', 'Site de teste: abrir painel');
  selo.innerHTML = '<i aria-hidden="true"></i><span id="stTesteRot"></span>';
  function rotulo() {
    var curto = window.innerWidth < 600;
    doc.getElementById('stTesteRot').textContent = curto ? 'TESTE' : 'SITE DE TESTE';
  }

  var painel = doc.createElement('div');
  painel.id = 'stTestePainel';
  painel.className = 'st-teste-painel';
  painel.setAttribute('role', 'dialog');
  painel.setAttribute('aria-label', 'Painel do site de teste');
  painel.hidden = true;
  painel.innerHTML =
    '<h2>Site de teste</h2>' +
    '<p>Só para a equipe. Não divulgue este link. O TagMe aqui é o de verdade: no teste, escolha o ambiente Teste.</p>' +
    '<p class="st-teste-estado" aria-live="polite"><span id="stTesteTexto"></span><small id="stTesteHora"></small></p>' +
    '<div class="st-teste-grade" id="stTesteHoras">' +
    '<button type="button" data-h="14:00">14h (antes)</button>' +
    '<button type="button" data-h="16:00">16h (aberto)</button>' +
    '<button type="button" data-h="18:30">18h30 (encerrado)</button>' +
    '<button type="button" data-h="">Hora real</button>' +
    '</div>' +
    '<div class="st-teste-grade" id="stTesteDias">' +
    '<button type="button" data-d="seg">Simular segunda (fechado)</button>' +
    '<button type="button" data-d="">Data real</button>' +
    '</div>' +
    '<button type="button" class="st-teste-fechar">Fechar</button>';

  /* fase 2: o Pix desta página é simulado (nada real é criado). Os botões fazem as
     próximas consultas do Pix na tela voltarem com o estado escolhido; o seletor muda
     a resposta da busca da reserva em /reserva/pagar/. Só nas páginas com o pix.js. */
  var X = window.SantoPix;
  if (X && X.simular) {
    var grupo = doc.createElement('div');
    grupo.className = 'st-teste-pix';
    var temBusca = !!doc.getElementById('procurar');
    grupo.innerHTML =
      '<h2>Pagamento (simulado)</h2>' +
      '<p>Só existe no site de teste.</p>' +
      '<p class="st-teste-estado" id="stPixEstado" aria-live="polite"></p>' +
      '<div class="st-teste-grade" id="stPixBotoes">' +
      '<button type="button" data-p="aprovado">Simular pagamento aprovado</button>' +
      '<button type="button" data-p="expirado">Simular Pix vencido</button>' +
      '<button type="button" data-p="recusado">Simular recusado</button>' +
      '<button type="button" data-p="estornado">Simular devolvido</button>' +
      '<button type="button" data-p="manual">Simular confirmação manual</button>' +
      '</div>' +
      (temBusca ? '<label for="stPixBusca">Ao procurar a reserva' +
        '<select id="stPixBusca"><option value="">normal</option><option value="nenhuma">não achar</option>' +
        '<option value="varias">achar várias</option><option value="confirmada">já confirmada</option>' +
        '<option value="indisponivel">fora do ar</option></select></label>' : '');
    painel.insertBefore(grupo, painel.querySelector('.st-teste-fechar'));
    var NOMES_PIX = { aprovado: 'aprovado', expirado: 'vencido', recusado: 'recusado', estornado: 'devolvido', manual: 'confirmação manual' };
    var estadoPix = function (aviso) {
      var s = X.simulando();
      grupo.querySelector('#stPixEstado').textContent = aviso ||
        (s.temPix ? 'Pix na tela.' + (s.pagamento ? ' Próximas consultas: ' + NOMES_PIX[s.pagamento] + '.' : ' Consultas normais.')
                  : 'Nenhum Pix na tela. Gere um Pix e depois escolha o resultado.');
      [].forEach.call(grupo.querySelectorAll('button[data-p]'), function (b) {
        b.setAttribute('aria-pressed', String(!!s.temPix && b.getAttribute('data-p') === s.pagamento));
      });
      var sel = grupo.querySelector('#stPixBusca');
      if (sel && sel.value !== (s.busca || '')) sel.value = s.busca || '';
    };
    grupo.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-p]') : null;
      if (!b) return;
      if (X.simular(b.getAttribute('data-p'))) { estadoPix(); abrir(false); selo.focus(); }
      else estadoPix('Nenhum Pix na tela. Gere um Pix e depois escolha o resultado.');
    });
    var sel = grupo.querySelector('#stPixBusca');
    if (sel) sel.addEventListener('change', function () { X.simularBusca(this.value || null); estadoPix(); });
    if (X.aoSimular) X.aoSimular(function () { estadoPix(); });
    estadoPix();
  }

  function dois(n) { return (n < 10 ? '0' : '') + n; }
  /* próxima segunda-feira depois da data que o site está usando (AAAA-MM-DD) */
  function proximaSegunda() {
    var p = S.agora().data.split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== 1);
    return d.getUTCFullYear() + '-' + dois(d.getUTCMonth() + 1) + '-' + dois(d.getUTCDate());
  }
  function hhmm(min) { return dois(Math.floor(min / 60)) + ':' + dois(min % 60); }

  function atualizar() {
    var a = S.agora(), sim = S.simulando() || {};
    doc.getElementById('stTesteTexto').textContent = S.texto();
    var h = hhmm(a.minutos) + (sim.hora ? ' (simulada)' : '');
    var p = a.data.split('-');
    var d = p[2] + '/' + p[1] + '/' + p[0] + (sim.dia ? ' (simulada)' : '');
    doc.getElementById('stTesteHora').textContent = 'Hora usada: ' + h + '. Data usada: ' + d + '.';
    [].forEach.call(painel.querySelectorAll('#stTesteHoras button'), function (b) {
      b.setAttribute('aria-pressed', String((b.getAttribute('data-h') || null) === (sim.hora || null)));
    });
    [].forEach.call(painel.querySelectorAll('#stTesteDias button'), function (b) {
      var dia = b.getAttribute('data-d');
      b.setAttribute('aria-pressed', String(dia ? !!sim.dia : !sim.dia));
    });
    selo.classList.toggle('st-teste-sim', !!(sim.hora || sim.dia));
  }

  /* o selo não pode cobrir o rodapé fixo da reserva: sobe junto com ele */
  function posicionar() {
    var rod = doc.querySelector('.rodape'), b = 10;
    if (rod) {
      var r = rod.getBoundingClientRect();
      if (r.height && r.top < window.innerHeight) b = Math.round(window.innerHeight - r.top) + 8;
    }
    selo.style.bottom = b + 'px';
    painel.style.bottom = (b + 38) + 'px';
    painel.style.maxHeight = 'calc(100vh - ' + (b + 60) + 'px)';
  }

  function abrir(sim) {
    painel.hidden = !sim;
    selo.setAttribute('aria-expanded', String(sim));
    if (sim) { posicionar(); atualizar(); var f = painel.querySelector('button'); if (f) f.focus(); }
  }
  selo.addEventListener('click', function () { abrir(painel.hidden); });
  painel.querySelector('.st-teste-fechar').addEventListener('click', function () { abrir(false); selo.focus(); });
  doc.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !painel.hidden) { abrir(false); selo.focus(); }
  });
  painel.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-h],button[data-d]') : null;
    if (!b) return;
    if (b.hasAttribute('data-h')) S.simular(b.getAttribute('data-h') || null);
    else S.simularDia(b.getAttribute('data-d') === 'seg' ? proximaSegunda() : null);
    atualizar();
  });

  if (S.aoMudar) S.aoMudar(atualizar);
  window.addEventListener('resize', function () { rotulo(); posicionar(); });

  /* Some enquanto o TagMe estiver na tela (no celular cobriria o botão do canto) */
  var visiveis = 0;
  function esconder() {
    var ocultar = visiveis > 0;
    selo.style.display = ocultar ? 'none' : '';
    if (ocultar) abrir(false);
  }
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        var antes = e.target.__stVis || false, agora = e.isIntersecting;
        e.target.__stVis = agora;
        if (agora && !antes) visiveis++;
        else if (!agora && antes) visiveis--;
      });
      esconder();
    }, { threshold: 0.15 });
    var vistos = [];
    var procurar = function () {
      [].forEach.call(doc.querySelectorAll('iframe[src*="tagme.com.br"]'), function (f) {
        if (vistos.indexOf(f) < 0) { vistos.push(f); io.observe(f); }
      });
    };
    procurar();
    if (window.MutationObserver) {
      new MutationObserver(function () {
        procurar();
        /* iframe removido: tira da conta */
        vistos = vistos.filter(function (f) {
          if (doc.contains(f)) return true;
          io.unobserve(f);
          if (f.__stVis) { f.__stVis = false; visiveis = Math.max(0, visiveis - 1); esconder(); }
          return false;
        });
      }).observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    }
  }
  window.addEventListener('scroll', posicionar, { passive: true });

  doc.body.appendChild(selo);
  doc.body.appendChild(painel);
  rotulo();
  posicionar();
  atualizar();
  /* a reserva troca de passo e o rodapé muda de tamanho: reconfere de vez em quando */
  setInterval(posicionar, 1000);
})();
