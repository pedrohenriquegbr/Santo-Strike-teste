/* Santo Strike: pagamento por Pix dentro do site (fase 2).
   Usado pela reserva de 8 passos (/reserva/) e pela página /reserva/pagar/.
   Script clássico, sem módulo e sem dependência. Injeta o próprio CSS (classes
   .pix-*), que usa as variáveis de cor e de fonte da página. Carregue depois do
   /assets/hoje.js e antes do script da página:
     <script src="/assets/pix.js"></script>

   O navegador só fala com as rotas do próprio site (/api/...). Nenhuma chave,
   nenhum endereço de fora. Nenhuma função daqui lança erro: falha de rede vira
   { ok:false, erro:'indisponivel' }.

   window.SantoPix
   ---------------
   Rotas (todas devolvem Promise com o JSON da rota mais `http`, o status HTTP):
     criar(corpo)               POST /api/pix-criar/      (corpo do contrato, sem mudar nada)
     jaPago(r)                  true se criar() respondeu 409 ja_pago (a reserva já tem Pix pago; r.numero)
     status(id, token)          GET  /api/pix-status/     (no site de teste leva o `simular` do painel)
     cancelar(id, token)        POST /api/pix-cancelar/   (D9: a página largou este Pix; pendente = cancelado no
                                Mercado Pago; já pago = 409 ja_pago com `numero` e `valor`, ver jaPago)
     procurarReserva(dados)     POST /api/tagme-reserva/  ({ fone, dia, pessoas, piso })
     disponivel()               Promise<boolean>: o pagamento no site existe neste servidor?
                                O contrato não tem rota para isso; usa GET /api/pix-status/ sem id:
                                503 = não existe (a página fica como era antes da fase 2);
                                403 token_invalido = existe. Qualquer outra resposta = não existe.
                                A resposta fica guardada enquanto a página estiver aberta.

   Bloco de pagamento:
     montar(el, opcoes)  desenha o Pix dentro de `el` e consulta o pagamento sozinho.
       opcoes.pix              resposta de criar(): { id, token, valor, copiaECola, qrImagem, expiraEm, modo }
       opcoes.tituloEl         o <h1> da página: recebe o título de cada estado e o foco
       opcoes.tituloNoBloco    true = o bloco repete o título para quem enxerga (quando o <h1> fica longe)
       opcoes.linhaReserva     texto opcional no topo ("Reserva de hoje, 19h, 6 pessoas.")
       opcoes.valorEsperado    valor que a página mostrou (padrão: pix.valor)
       opcoes.comEquipe        true = a reserva já existe na casa: os textos falam em "falar com a equipe"
       opcoes.saida            { texto, aoTocar } ou { texto, href } : a saída para o WhatsApp
       opcoes.zap(motivo)      devolve o link do WhatsApp da casa para 'nao_apareceu' e 'devolvido'
       opcoes.cancelar         HTML da resposta de "Posso cancelar?" (sem isso a pergunta não aparece)
       opcoes.aoAprovar(s)     pagamento aprovado e valor igual ao esperado (s = resposta de status)
       opcoes.aoValorDiferente(s)  aprovado com valor diferente do esperado: a página NÃO libera nada
       opcoes.aoGerarOutro()   tocou em "Gerar um novo Pix" (a página cria outro e chama montar de novo)
       opcoes.aoFalhar(erro)   a consulta foi recusada de vez (token_invalido, nao_encontrado)
       opcoes.aoMudar(estado)  'pix' | 'aguardando' | 'expirado' | 'recusado' | 'estornado' | 'aprovado'
       opcoes.retomada         true = a página reabriu com este Pix guardado: entra em "Esperando o seu pagamento"
                               e consulta na hora; se o prazo já passou, entra em "O Pix venceu" SEM afirmar nada
                               sobre cobrança até o servidor responder (com "Já paguei, verificar agora")
     devolve { estado(), verificar(), pausar(), retomar(), destruir() }
     Consulta a cada 4 s; para com a aba escondida e depois do vencimento; consulta na hora
     quando a pessoa volta para a aba (visibilitychange e pageshow); recua se a rede falhar e,
     da 2ª falha seguida em diante, diz na tela "Sem conexão...". "Gerar um novo Pix" depois do
     vencido confere o Pix antigo e NÃO gera outro se o servidor não responder.

   Site de teste (só com SantoHoje.CONFIG.teste):
     simular(estado)       'aprovado' | 'expirado' | 'recusado' | 'estornado' | 'manual' | null.
                           Vale para o Pix que está na tela; devolve false se não há Pix na tela.
     simularBusca(valor)   'nenhuma' | 'varias' | 'confirmada' | 'indisponivel' | null (procurarReserva)
     simulando()           { pagamento, busca, temPix }
     aoSimular(fn)         avisa o painel quando algo acima muda

   Ajudas:
     moeda(n)              "R$ 59,99"
     centavos(n)           5999
     horaDe(iso)           "19h42", sempre no fuso de São Paulo
     noCelular             a mesma regra de celular/computador da reserva
     novaTentativa()       identificador novo para o campo `tentativa`
     copiar(texto)         Promise<boolean>
     copiarCom(botao, texto, feito)   copia e troca o texto do botão por 3 s
     anunciar(texto, alerta)          fala no leitor de tela (aria-live; alerta = role="alert")
     faixaTeste(modo, curto, extra)   HTML do aviso "Modo de teste" ('' fora do teste)
     ICONES                { ok, relogio, aviso } em SVG
     focar(el)             põe o foco num título sem rolar a página
     aVista(el)            rola até `el` só se ele estiver fora da tela
     guardar(chave, obj) / ler(chave) / apagar(chave)   localStorage, sempre em try/catch
     TITULOS               título de cada estado do bloco */
(function (w) {
  'use strict';
  if (w.SantoPix) return;
  var doc = w.document;

  var BASE = '/api/';            /* caminho das rotas, sempre com a barra no fim */
  var TEMPO_LIMITE = 12000;      /* 12 s por chamada */
  var INTERVALO = 4000;          /* consulta do pagamento */
  var VALIDADE_MS = 30.5 * 60000; /* o Pix vale 30 min e 30 s */

  function ehTeste() { var h = w.SantoHoje; return !!(h && h.CONFIG && h.CONFIG.teste); }
  var enc = encodeURIComponent;

  /* ---------- rotas ---------- */
  function chamar(metodo, caminho, corpo) {
    return new Promise(function (resolve) {
      var feito = false, timer = null, ctrl = null;
      function fim(r) { if (feito) return; feito = true; if (timer) clearTimeout(timer); resolve(r); }
      function falha(http) { return { ok: false, erro: 'indisponivel', http: http || 0 }; }
      try {
        if (typeof w.fetch !== 'function') { fim(falha()); return; }
        var op = { method: metodo, headers: { 'Accept': 'application/json' }, cache: 'no-store', credentials: 'same-origin' };
        if (corpo) { op.headers['Content-Type'] = 'application/json'; op.body = JSON.stringify(corpo); }
        if (w.AbortController) { ctrl = new w.AbortController(); op.signal = ctrl.signal; }
        timer = setTimeout(function () { try { if (ctrl) ctrl.abort(); } catch (e) {} fim(falha()); }, TEMPO_LIMITE);
        w.fetch(BASE + caminho, op).then(function (res) {
          return res.text().then(function (txt) {
            var j = null;
            try { j = JSON.parse(txt); } catch (e) { j = null; }
            if (!j || typeof j !== 'object') { fim(falha(res.status)); return; }
            if (j.ok !== true || !res.ok) { j.ok = false; if (!j.erro) j.erro = 'indisponivel'; }
            j.http = res.status;
            fim(j);
          });
        }).catch(function () { fim(falha()); });
      } catch (e) { fim(falha()); }
    });
  }

  var sim = { pagamento: null, busca: null };
  var ativo = null;              /* o bloco de pagamento que está na tela */
  var ouvintesSim = [];
  function avisarSim() { ouvintesSim.slice().forEach(function (fn) { try { fn(); } catch (e) {} }); }

  var api = { BASE: BASE };
  api.criar = function (corpo) { return chamar('POST', 'pix-criar/', corpo); };
  /* 409 ja_pago (com `numero`): esta reserva já tem um Pix pago. Não é erro: a tela mostra o número e a saída para o WhatsApp */
  api.jaPago = function (r) { return !!(r && r.ok === false && r.erro === 'ja_pago'); };
  api.status = function (id, token) {
    return chamar('GET', 'pix-status/?id=' + enc(id) + '&token=' + enc(token) +
      (ehTeste() && sim.pagamento ? '&simular=' + enc(sim.pagamento) : ''));
  };
  /* D9: o Pix que a página larga não pode continuar pagável sem nenhuma tela acompanhando */
  api.cancelar = function (id, token) {
    var corpo = { id: id, token: token };
    if (ehTeste() && sim.pagamento) corpo.simular = sim.pagamento;
    return chamar('POST', 'pix-cancelar/', corpo);
  };
  api.procurarReserva = function (d) {
    var corpo = { fone: d.fone, dia: d.dia, pessoas: d.pessoas, piso: d.piso };
    if (ehTeste() && sim.busca) corpo.simular = sim.busca;
    return chamar('POST', 'tagme-reserva/', corpo);
  };
  var sonda = null;
  api.disponivel = function () {
    if (!sonda) {
      sonda = chamar('GET', 'pix-status/').then(function (r) { return r.http === 403 && r.erro === 'token_invalido'; });
    }
    return sonda;
  };

  /* ---------- site de teste ---------- */
  api.simular = function (estado) {
    if (!ehTeste()) return false;
    sim.pagamento = estado || null;
    var tem = !!(ativo && ativo.vivo());
    if (tem) ativo.verificar();
    avisarSim();
    return tem;
  };
  api.simularBusca = function (v) { if (!ehTeste()) return; sim.busca = v || null; avisarSim(); };
  api.simulando = function () { return { pagamento: sim.pagamento, busca: sim.busca, temPix: !!(ativo && ativo.vivo()) }; };
  api.aoSimular = function (fn) { if (typeof fn === 'function') ouvintesSim.push(fn); };

  /* ---------- ajudas ---------- */
  api.moeda = function (v) { return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); };
  api.centavos = function (v) { return Math.round(Number(v) * 100); };
  api.noCelular = /Android|iPhone|iPad|iPod/i.test(w.navigator.userAgent || '') ||
                  (w.navigator.maxTouchPoints > 1 && /Mac/.test(w.navigator.platform || ''));
  /* "19h42" ou "19h", no fuso de São Paulo, nunca no do aparelho */
  api.horaDe = function (iso) {
    var t = new Date(iso), h, m;
    if (isNaN(t.getTime())) return '';
    try {
      var p = {};
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(t).forEach(function (x) { p[x.type] = x.value; });
      h = (+p.hour) % 24; m = p.minute;
    } catch (e) {
      var u = new Date(t.getTime() - 3 * 3600000);
      h = u.getUTCHours(); m = ('0' + u.getUTCMinutes()).slice(-2);
    }
    return h + 'h' + (m === '00' ? '' : m);
  };
  api.novaTentativa = function () {
    var c = w.crypto;
    try { if (c && c.randomUUID) return c.randomUUID(); } catch (e) {}
    try {
      if (c && c.getRandomValues) {
        var b = new Uint8Array(16), s = '';
        c.getRandomValues(b);
        for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
        return s;
      }
    } catch (e) {}
    return 't' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
  };

  api.copiar = function (texto) {
    function antigo() {
      var ok = false, t = doc.createElement('textarea');
      t.value = texto; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.top = '0'; t.style.opacity = '0';
      doc.body.appendChild(t); t.select();
      try { t.setSelectionRange(0, texto.length); ok = doc.execCommand('copy'); } catch (e) { ok = false; }
      doc.body.removeChild(t);
      return ok;
    }
    try {
      if (w.navigator.clipboard && w.navigator.clipboard.writeText) {
        return w.navigator.clipboard.writeText(texto).then(function () { return true; }, function () { return antigo(); });
      }
    } catch (e) {}
    return Promise.resolve(antigo());
  };
  /* copia e dá o retorno no próprio botão por 3 s e no leitor de tela */
  api.copiarCom = function (botao, texto, feito) {
    var rot = botao.querySelector('[data-rot]') || botao;
    if (!botao.__pixTexto) botao.__pixTexto = rot.textContent;
    return api.copiar(texto).then(function (ok) {
      rot.textContent = ok ? feito : 'Não deu para copiar';
      api.anunciar(ok ? feito + '.' : 'Não deu para copiar. Selecione o texto e copie.');
      botao.classList.toggle('pix-feito', ok);
      clearTimeout(botao.__pixTimer);
      botao.__pixTimer = setTimeout(function () { rot.textContent = botao.__pixTexto; botao.classList.remove('pix-feito'); }, 3000);
      return ok;
    });
  };

  /* leitor de tela: uma região educada e uma de alerta, criadas uma vez só */
  var vivo = null, alerta = null;
  function regioes() {
    if (vivo || !doc.body) return;
    vivo = doc.createElement('div');
    vivo.id = 'pixVivo'; vivo.className = 'pix-so-leitor'; vivo.setAttribute('aria-live', 'polite'); vivo.setAttribute('role', 'status');
    alerta = doc.createElement('div');
    alerta.id = 'pixAlerta'; alerta.className = 'pix-so-leitor'; alerta.setAttribute('role', 'alert');
    doc.body.appendChild(vivo); doc.body.appendChild(alerta);
  }
  /* C4: as regiões nascem vazias logo que o script carrega; texto posto numa região recém-criada se perde */
  if (doc.body) regioes(); else doc.addEventListener('DOMContentLoaded', regioes);
  api.anunciar = function (texto, comoAlerta) {
    regioes();
    var el = comoAlerta ? alerta : vivo;
    if (!el) return;
    el.textContent = '';
    setTimeout(function () { el.textContent = texto; }, 60);
  };
  api.focar = function (el) {
    if (!el) return;
    try { el.tabIndex = -1; el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
  };
  var REDUZ = !!(w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches);
  api.aVista = function (el) {
    if (!el || !el.getBoundingClientRect) return;
    var r = el.getBoundingClientRect(), alt = w.innerHeight || 0;
    if (r.top >= 0 && r.top <= alt * 0.55) return;
    try { el.scrollIntoView({ behavior: REDUZ ? 'auto' : 'smooth', block: 'start' }); } catch (e) { el.scrollIntoView(true); }
  };

  api.guardar = function (chave, obj) { try { w.localStorage.setItem(chave, JSON.stringify(obj)); return true; } catch (e) { return false; } };
  api.ler = function (chave) {
    try { var v = w.localStorage.getItem(chave); if (!v) return null; var o = JSON.parse(v); return o && typeof o === 'object' ? o : null; }
    catch (e) { return null; }
  };
  api.apagar = function (chave) { try { w.localStorage.removeItem(chave); } catch (e) {} };

  var ICO_AVISO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5 2.5 20h19L12 3.5Z"/><path d="M12 10v4.5"/><path d="M12 17.4v.1"/></svg>';
  /* curto = sem a frase do código (telas em que o código já não aparece); extra = frase a mais, em negrito */
  api.faixaTeste = function (modo, curto, extra) {
    var txt = '';
    if (modo === 'simulado') {
      txt = '<b>Modo de teste.</b> Este Pix é simulado: nenhum Pix de verdade foi criado e ninguém será cobrado.' +
        (curto ? '' : ' Não tente pagar este código no seu banco.');
    } else if (ehTeste()) {
      txt = '<b>Modo de teste.</b> Pagamento com credencial de teste do Mercado Pago. Não use dinheiro real.';
    }
    if (extra) txt += (txt ? ' ' : '') + '<b>' + extra + '</b>';
    return txt ? '<div class="pix-teste" role="note">' + ICO_AVISO + '<p>' + txt + '</p></div>' : '';
  };

  api.TITULOS = {
    pix: 'Pague o Pix',
    aguardando: 'Esperando o seu pagamento',
    expirado: 'O Pix venceu',
    recusado: 'O banco não aceitou',
    estornado: 'Este pagamento foi devolvido'
  };

  /* ---------- CSS ---------- */
  var css = [
    '.pix-so-leitor{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
    '.pix{--pix-ok:#8FCB7A;text-align:left;scroll-margin-top:1rem;display:grid;gap:.9rem;min-width:0}',
    '.pix > *{margin:0;min-width:0}',
    '.pix [hidden]{display:none !important}',
    /* botões: os mesmos da reserva (pílula dourada, fantasma e link) */
    '.pix-btn{display:flex;align-items:center;justify-content:center;gap:.55rem;width:100%;min-height:3.25rem;margin:0;border:1px solid transparent;border-radius:999px;',
    'background:var(--accent,#E3B23C);color:var(--canvas,#0B0705);cursor:pointer;text-decoration:none;text-align:center;',
    'font:700 .98rem/1.2 var(--body,"DM Sans",system-ui,sans-serif);padding:.9rem 1.4rem;-webkit-tap-highlight-color:transparent;',
    'transition:transform .15s var(--ease,ease),background .2s var(--ease,ease),border-color .2s var(--ease,ease),color .2s var(--ease,ease)}',
    '.pix-btn:hover{background:var(--accent-2,#F2C65A)}',
    '.pix-btn:active{transform:scale(.97)}',
    '.pix-btn:focus-visible{outline:2px solid var(--ink,#F6F1E6);outline-offset:3px;border-radius:999px}',
    '.pix-btn[disabled],.pix-btn[aria-disabled="true"]{opacity:.5;cursor:not-allowed;pointer-events:none}',
    '.pix-btn[data-ocupado]{opacity:.75;cursor:progress}',
    '.pix-btn--fantasma{background:none;border-color:var(--line-strong,rgba(227,178,60,.42));color:var(--ink,#F6F1E6);font-weight:500}',
    '.pix-btn--fantasma:hover{background:var(--panel-2,#1E150D);border-color:var(--accent,#E3B23C);color:var(--accent,#E3B23C)}',
    '.pix-btn--fantasma:focus-visible{outline-color:var(--accent,#E3B23C)}',
    '.pix-btn.pix-feito{background:var(--panel-2,#1E150D);border-color:var(--pix-ok,#8FCB7A);color:var(--pix-ok,#8FCB7A)}',
    '.pix-link{display:inline-flex;align-items:center;justify-content:flex-start;min-height:48px;margin:0;padding:.35rem .1rem;background:none;border:0;',
    'color:var(--accent,#E3B23C);font:500 .95rem/1.35 var(--body,"DM Sans",system-ui,sans-serif);text-align:left;text-decoration:underline;',
    'text-underline-offset:3px;text-decoration-thickness:1px;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:color .2s var(--ease,ease)}',
    '.pix-link:hover{color:var(--accent-2,#F2C65A);text-decoration-thickness:2px}',
    '.pix-link:active{opacity:.75}',
    '.pix-link:focus-visible{outline:2px solid var(--accent,#E3B23C);outline-offset:2px;border-radius:6px}',
    '.pix-link[disabled],.pix-link[aria-disabled="true"]{opacity:.6;cursor:progress;text-decoration:none}',
    '.pix-acoes{display:grid;gap:.15rem;justify-items:start}',
    /* aviso do modo de teste: igual ao alerta laranja de /reserva/hoje/ */
    '.pix-teste{display:grid;grid-template-columns:1.35rem 1fr;gap:.7rem;align-items:start;text-align:left;border:1.5px solid var(--ember,#C2410C);',
    'background:rgba(194,65,12,.17);border-radius:12px;padding:.8rem .95rem;font-size:.88rem;line-height:1.5;color:var(--ink,#F6F1E6)}',
    '.pix-teste svg{width:1.35rem;height:1.35rem;color:#FF8A5C;margin-top:.1rem}',
    '.pix-teste p{margin:0}',
    '.pix-teste b{color:#FFA07A}',
    /* título repetido dentro do bloco, para quem enxerga */
    '.pix-titulo{display:flex;align-items:center;gap:.6rem;font:400 1.3rem/1.2 var(--display,"Prata",Georgia,serif);color:var(--ink,#F6F1E6)}',
    '.pix-selo{flex:none;display:grid;place-items:center;width:2.1rem;height:2.1rem;border-radius:50%;border:1.5px solid var(--accent,#E3B23C);color:var(--accent,#E3B23C)}',
    '.pix-selo svg{width:1.05rem;height:1.05rem}',
    '.pix-selo--ok{border-color:var(--pix-ok,#8FCB7A);color:var(--pix-ok,#8FCB7A)}',
    '.pix-reserva{font:500 .75rem/1.45 var(--mono,"JetBrains Mono",ui-monospace,monospace);letter-spacing:.12em;text-transform:uppercase;color:var(--accent,#E3B23C)}',
    /* confiança: quatro linhas, nunca em letra miúda */
    '.pix-confia{list-style:none;padding:.85rem 1rem;border:1px solid var(--line,rgba(227,178,60,.18));border-radius:12px;background:var(--panel,#150F0A);',
    'display:grid;gap:.4rem;font-size:.95rem;line-height:1.45;color:var(--ink-2,#B9AC98)}',
    '.pix-confia li{display:grid;grid-template-columns:.9rem 1fr;gap:.4rem}',
    '.pix-confia li::before{content:"•";color:var(--accent,#E3B23C);font-weight:700}',
    '.pix-confia b{color:var(--ink,#F6F1E6);font-weight:700}',
    '.pix-confia .pix-forte{color:var(--accent,#E3B23C);font:500 1.02rem/1.3 var(--mono,"JetBrains Mono",ui-monospace,monospace);font-variant-numeric:tabular-nums}',
    '.pix-espera{font-size:1rem;line-height:1.5;color:var(--ink,#F6F1E6)}',
    '.pix-falta{justify-self:start;display:inline-flex;align-items:center;gap:.5rem;font:500 .875rem/1 var(--mono,"JetBrains Mono",ui-monospace,monospace);letter-spacing:.06em;',
    'color:var(--accent,#E3B23C);border:1px solid var(--line-strong,rgba(227,178,60,.42));border-radius:999px;padding:.55rem .85rem}',
    '.pix-falta i{width:.45rem;height:.45rem;border-radius:50%;background:var(--accent,#E3B23C);animation:pixPulso 2.2s var(--ease,ease) infinite}',
    '@keyframes pixPulso{0%{box-shadow:0 0 0 0 rgba(227,178,60,.55)}70%{box-shadow:0 0 0 .4rem rgba(227,178,60,0)}100%{box-shadow:0 0 0 0 rgba(227,178,60,0)}}',
    /* código copia e cola */
    '.pix-campo{display:block}',
    '.pix-campo span{display:block;font:500 .75rem/1.35 var(--mono,"JetBrains Mono",ui-monospace,monospace);letter-spacing:.14em;text-transform:uppercase;',
    'color:var(--ink-2,#B9AC98);margin-bottom:.4rem}',
    '.pix-campo textarea{display:block;width:100%;height:3.6rem;resize:none;background:var(--panel,#150F0A);border:1px solid var(--line,rgba(227,178,60,.18));border-radius:10px;',
    'color:var(--ink-2,#B9AC98);font:400 .78rem/1.45 var(--mono,"JetBrains Mono",ui-monospace,monospace);padding:.6rem .75rem;word-break:break-all;',
    'transition:border-color .2s var(--ease,ease)}',
    '.pix-campo textarea:hover{border-color:var(--line-strong,rgba(227,178,60,.42))}',
    '.pix-campo textarea:focus-visible{outline:2px solid var(--accent,#E3B23C);outline-offset:2px;border-color:var(--accent,#E3B23C)}',
    '.pix-passos{padding:0 0 0 1.3rem;display:grid;gap:.4rem;font-size:.95rem;line-height:1.45;color:var(--ink-2,#B9AC98)}',
    '.pix-passos li::marker{color:var(--accent,#E3B23C);font-weight:700}',
    '.pix-passos b{color:var(--ink,#F6F1E6)}',
    '.pix-nota{font-size:.88rem;color:var(--ink-2,#B9AC98)}',
    '.pix-texto{font-size:1rem;line-height:1.55;color:var(--ink,#F6F1E6)}',
    '.pix-texto b{color:var(--accent,#E3B23C)}',
    '.pix-retorno{font-size:.9rem;color:var(--ink,#F6F1E6);min-height:0}',
    '.pix-retorno:empty{display:none}',
    '.pix-prefere{font-size:.95rem;color:var(--ink-2,#B9AC98)}',
    /* QR: imagem do Mercado Pago ou, no modo simulado, um desenho que não é um QR de verdade */
    '.pix-qr{width:200px;max-width:100%;aspect-ratio:1 / 1;border-radius:12px;background:#F6F1E6;padding:12px}',
    '.pix-qr img{display:block;width:100%;height:100%;image-rendering:pixelated}',
    '.pix-qr-falso{position:relative;width:100%;height:100%;display:grid;place-items:center;overflow:hidden;',
    'background-image:conic-gradient(#0B0705 25%,transparent 0 50%,#0B0705 0 75%,transparent 0);background-size:16px 16px}',
    '.pix-qr-falso i{position:absolute;width:46px;height:46px;background:#0B0705;border:7px solid #0B0705;box-shadow:inset 0 0 0 6px #F6F1E6;outline:5px solid #F6F1E6}',
    '.pix-qr-falso i:nth-child(1){top:0;left:0}.pix-qr-falso i:nth-child(2){top:0;right:0}.pix-qr-falso i:nth-child(3){bottom:0;left:0}',
    '.pix-qr-falso span{position:relative;background:#F6F1E6;color:#0B0705;border:2px solid #0B0705;border-radius:6px;padding:.4rem .55rem;',
    'font:700 .64rem/1 var(--mono,"JetBrains Mono",ui-monospace,monospace);letter-spacing:.1em;text-transform:uppercase;white-space:nowrap}',
    '.pix-duo{display:grid;gap:1rem;justify-items:start}',
    '@media (min-width:30rem){.pix-duo{grid-template-columns:200px 1fr;align-items:center;gap:1.2rem}}',
    /* perguntas que a tela responde sozinha */
    '.pix-det{border-top:1px solid var(--line,rgba(227,178,60,.18))}',
    '.pix-duvidas{display:grid}',
    '.pix-duvidas .pix-det:last-child{border-bottom:1px solid var(--line,rgba(227,178,60,.18))}',
    '.pix-det summary{display:flex;align-items:center;justify-content:space-between;gap:.8rem;min-height:48px;padding:.2rem 0;cursor:pointer;list-style:none;',
    'font:500 .95rem/1.35 var(--body,"DM Sans",system-ui,sans-serif);color:var(--ink,#F6F1E6);-webkit-tap-highlight-color:transparent;transition:color .2s var(--ease,ease)}',
    '.pix-det summary::-webkit-details-marker{display:none}',
    '.pix-det summary::after{content:"+";flex:none;font:400 1.2rem/1 var(--body,"DM Sans",system-ui,sans-serif);color:var(--accent,#E3B23C);transition:transform .2s var(--ease,ease)}',
    '.pix-det[open] summary::after{transform:rotate(45deg)}',
    '.pix-det summary:hover{color:var(--accent,#E3B23C)}',
    '.pix-det summary:active{opacity:.75}',
    '.pix-det summary:focus-visible{outline:2px solid var(--accent,#E3B23C);outline-offset:2px;border-radius:6px}',
    '.pix-det > div{padding:0 0 .9rem;display:grid;gap:.7rem;font-size:.92rem;line-height:1.55;color:var(--ink-2,#B9AC98)}',
    '.pix-det > div p{margin:0}',
    '.pix-det a:not(.pix-btn){color:var(--accent,#E3B23C)}',
    '.pix-det--qr{border:1px solid var(--line,rgba(227,178,60,.18));border-radius:12px;padding:0 1rem}',
    '.pix-det--qr summary{color:var(--ink-2,#B9AC98)}',
    '@media (prefers-reduced-motion:reduce){.pix-btn,.pix-link,.pix-det summary,.pix-det summary::after,.pix-campo textarea{transition:none}',
    '.pix-btn:active{transform:none}.pix-falta i{animation:none}}'
  ].join('');
  if (!doc.getElementById('santoPixCss')) {
    var estilo = doc.createElement('style');
    estilo.id = 'santoPixCss';
    estilo.textContent = css;
    (doc.head || doc.documentElement).appendChild(estilo);
  }

  /* ---------- bloco de pagamento ---------- */
  var ICO_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  var ICO_RELOGIO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
  api.ICONES = { ok: ICO_OK, relogio: ICO_RELOGIO, aviso: ICO_AVISO };

  var FIM = {
    expirado: {
      texto: 'Passaram os 30 minutos e não recebemos o pagamento. Nada foi cobrado. Se você pagou agora, aguarde 1 minuto antes de gerar outro.',
      alerta: 'O Pix venceu. Você pode gerar outro.',
      /* B2: o prazo passou, mas o servidor não respondeu: a tela não afirma nada sobre cobrança */
      textoSemResposta: 'O prazo deste Pix terminou e não conseguimos conferir o pagamento agora. Se você já pagou, não pague de novo: toque em Já paguei, verificar agora.',
      alertaSemResposta: 'O Pix venceu. Não deu para conferir o pagamento.' },
    recusado: {
      texto: 'O pagamento não passou. Nenhum valor ficou com a casa. Você pode tentar de novo ou combinar pelo WhatsApp.',
      textoEquipe: 'O pagamento não passou. Nenhum valor ficou com a casa. Você pode tentar de novo ou falar com a equipe no WhatsApp.',
      alerta: 'O pagamento não foi aceito pelo banco.' },
    estornado: {
      texto: 'O valor voltou para você. A reserva não está paga. Gere outro Pix ou fale com a equipe.',
      alerta: 'O pagamento foi devolvido.' }
  };
  var SEM_REDE = 'Sem conexão. Vamos tentar de novo. Se você já pagou, não pague outra vez.';
  var NAO_CONFERIU = 'Não deu para conferir o pagamento agora. Se você pagou, não pague de novo: fale com a equipe.';
  function desligar(b, sim) { if (sim) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled'); }
  function desligado(b) { return b.getAttribute('aria-disabled') === 'true'; }
  function det(pergunta, corpo, nome) {
    return '<details class="pix-det"' + (nome ? ' data-pix="' + nome + '"' : '') + '><summary>' + pergunta + '</summary><div>' + corpo + '</div></details>';
  }

  api.montar = function (el, op) {
    op = op || {};
    var pix = op.pix || {};
    if (ativo) ativo.destruir();
    sim.pagamento = null;

    var expira = new Date(pix.expiraEm).getTime();
    if (isNaN(expira)) expira = Date.now() + VALIDADE_MS;
    var criadoEm = expira - VALIDADE_MS;
    var esperado = op.valorEsperado == null ? pix.valor : op.valorEsperado;
    var valorTxt = api.moeda(pix.valor), ate = api.horaDe(new Date(expira).toISOString());
    /* N5: no computador o <h1> fica perto do bloco; repetir o título só no celular */
    var comTitulo = !!op.tituloNoBloco && api.noCelular;
    var estado = 'pix', parado = false, pausado = false, saiu = false, vencendo = false, semRede = false;
    var falhas = 0, depois = 0, emCurso = null, timerPoll = null, timerTique = null;
    var avisou5 = expira - Date.now() <= 5 * 60000, avisou1 = expira - Date.now() <= 60000;
    function q(nome) { return el.querySelector('[data-pix="' + nome + '"]'); }
    function mudou(e) { if (op.aoMudar) { try { op.aoMudar(e); } catch (err) {} } }

    function titulo(e) {
      var t = api.TITULOS[e] || '';
      var tb = q('titulo');
      if (tb) tb.textContent = t;
      if (op.tituloEl && t) { op.tituloEl.textContent = t; api.focar(op.tituloEl); }
    }
    function saidaHtml() {
      var s = op.saida;
      if (!s || !s.texto) return '';
      return s.href ? '<a class="pix-link" data-pix="saida" href="#" target="_blank" rel="noopener">' + s.texto + '</a>'
                    : '<button type="button" class="pix-link" data-pix="saida">' + s.texto + '</button>';
    }
    function ligarSaida() {
      var b = q('saida'), s = op.saida;
      if (!b || !s) return;
      if (s.href) {
        var por = function () { try { b.href = typeof s.href === 'function' ? s.href() : s.href; } catch (e) {} };
        por(); b.addEventListener('click', por);
      } else b.addEventListener('click', function () { if (s.aoTocar) s.aoTocar(); });
    }
    function ligarZap(nome, motivo) {
      var a = q(nome);
      if (!a || !op.zap) return;
      var por = function () { try { a.href = op.zap(motivo); } catch (e) {} };
      por(); a.addEventListener('click', por);
    }

    /* ----- Pix na tela e aguardando ----- */
    function desenharPix() {
      var simulado = pix.modo === 'simulado';
      var temQr = typeof pix.qrImagem === 'string' && pix.qrImagem.indexOf('data:image/') === 0;
      var qr = temQr ? '<div class="pix-qr"><img data-pix="qr" alt="" width="176" height="176"></div>'
        : '<div class="pix-qr"><div class="pix-qr-falso" role="img" aria-label="QR Code de teste. Não funciona no banco."><i></i><i></i><i></i><span>QR de teste</span></div></div>';
      var campo = '<label class="pix-campo"><span>' + (simulado ? 'Código Pix de teste (não funciona no banco)' : 'Código Pix Copia e Cola') +
        '</span><textarea readonly rows="2" spellcheck="false" data-pix="codigo"></textarea></label>';
      var h = api.faixaTeste(pix.modo);
      if (comTitulo) h += '<p class="pix-titulo" data-pix="titulo" aria-hidden="true"></p>';
      if (op.linhaReserva) h += '<p class="pix-reserva" data-pix="reserva"></p>';
      h += '<ul class="pix-confia" data-pix="confia">' +
        '<li><span>Você paga para o <b>Santo Strike</b>.</span></li>' +
        '<li><span>Valor: <b class="pix-forte">' + valorTxt + '</b>. É o mesmo da sua reserva.</span></li>' +
        '<li><span>Vale até <b class="pix-forte">' + ate + '</b>.</span></li>' +
        '<li><span>Pagamento seguro pelo Pix, feito no app do seu banco. Não pedimos senha nem dados de cartão.</span></li></ul>';
      h += '<p class="pix-espera" data-pix="espera" hidden>Assim que o banco avisar, esta tela muda. Não precisa tocar em nada. Vale até ' + ate + '.</p>';
      h += '<p class="pix-falta" data-pix="falta" hidden><i aria-hidden="true"></i><span data-pix="faltaTxt"></span></p>';
      if (api.noCelular) {
        h += '<button type="button" class="pix-btn" data-pix="copiar"><span data-rot>Copiar código Pix</span></button>' + campo +
          '<ol class="pix-passos" data-pix="passos"><li>Copie o código.</li><li>Abra o app do seu banco e escolha Pix, Pix Copia e Cola.</li><li>Cole o código e confirme.</li></ol>' +
          '<details class="pix-det pix-det--qr"><summary>Pagar por outro aparelho (QR Code)</summary><div>' + qr +
          '<p>No outro aparelho, abra o app do banco, escolha Pix e leia o QR Code.</p></div></details>';
      } else {
        h += '<div class="pix-duo">' + qr + '<ol class="pix-passos"><li>Abra o app do seu banco.</li><li>Escolha Pix e leia o QR Code.</li><li>Confirme o pagamento.</li></ol></div>' +
          '<p class="pix-prefere">Prefere copiar? Use o código Pix Copia e Cola</p>' + campo +
          '<button type="button" class="pix-btn pix-btn--fantasma" data-pix="copiar"><span data-rot>Copiar código Pix</span></button>';
      }
      h += '<p class="pix-nota">Ao pagar, esta tela atualiza sozinha.</p>';
      h += '<div class="pix-acoes"><button type="button" class="pix-link" data-pix="verificar">Já paguei, verificar agora</button>' +
        '<p class="pix-retorno" data-pix="retorno"></p>' +
        '<button type="button" class="pix-link" data-pix="naoApareceu" hidden>Paguei e não apareceu</button></div>';
      h += '<div class="pix-duvidas">' +
        det('E se eu fechar esta tela?', '<p>Se você já pagou, o pagamento continua valendo. Volte a esta página neste mesmo aparelho e a tela mostra o resultado. Se não aparecer, fale com a equipe com o comprovante do banco.</p>') +
        det('Paguei e não apareceu.', '<p>Espere 1 minuto e toque em Verificar agora. Se continuar sem mudar, fale com a equipe: tenha o comprovante do banco à mão.</p>' +
          (op.zap ? '<a class="pix-btn pix-btn--fantasma" data-pix="zapAjuda" href="#" target="_blank" rel="noopener">Falar com a equipe no WhatsApp</a>' : ''), 'detNaoApareceu') +
        det('Paguei duas vezes, e agora?', '<p>Fale com a equipe pelo WhatsApp com os dois comprovantes. Ela resolve com você.</p>') +
        (op.cancelar ? det('Posso cancelar?', op.cancelar) : '') + '</div>';
      h += saidaHtml();
      el.innerHTML = '<div class="pix" data-fase="pix">' + h + '</div>';

      q('codigo').value = pix.copiaECola || '';
      if (op.linhaReserva) q('reserva').textContent = op.linhaReserva;
      if (temQr) {
        q('qr').src = pix.qrImagem;
        q('qr').alt = 'QR Code do Pix de ' + valorTxt + '. Para pagar sem ler o QR, use o código Pix Copia e Cola abaixo.';
      }
      q('copiar').addEventListener('click', function () { api.copiarCom(this, pix.copiaECola || '', 'Código copiado'); });
      q('codigo').addEventListener('focus', function () { try { this.select(); } catch (e) {} });
      q('verificar').addEventListener('click', verificarManual);
      q('naoApareceu').addEventListener('click', function () {
        var d = q('detNaoApareceu');
        d.open = true;
        api.aVista(d);
        try { d.querySelector('summary').focus({ preventScroll: true }); } catch (e) {}
      });
      ligarZap('zapAjuda', 'nao_apareceu');
      ligarSaida();
    }
    function fase(nova) {
      if (parado || estado === nova) return;
      estado = nova;
      var caixa = el.querySelector('.pix');
      if (caixa) caixa.setAttribute('data-fase', nova);
      var esperando = nova === 'aguardando';
      var c = q('confia'), p = q('passos');
      if (c) c.hidden = esperando;
      if (p) p.hidden = esperando;
      q('espera').hidden = !esperando;
      q('falta').hidden = !esperando;
      tique();
      titulo(nova);
      if (esperando) api.anunciar('Aguardando o pagamento.');
      mudou(nova);
    }
    function verificarManual() {
      var b = q('verificar'), ret = q('retorno');
      if (!b || desligado(b)) return;
      desligar(b, true); b.textContent = 'Verificando...';      /* C3: aria-disabled, o foco fica no botão */
      if (ret) ret.textContent = '';
      consultar().then(function (r) {
        var b2 = q('verificar'), ret2 = q('retorno');
        if (!b2) return;                       /* a tela já mudou de estado */
        desligar(b2, false); b2.textContent = 'Já paguei, verificar agora';
        var msg = '';
        if (!r || !r.ok) msg = 'Não deu para verificar agora. Tente de novo em instantes. Se você já pagou, não pague outra vez.';
        else if (r.status === 'pendente') { fase('aguardando'); msg = 'O pagamento ainda não apareceu. Assim que o banco avisar, esta tela muda.'; }
        if (msg) { ret2.textContent = msg; api.anunciar(msg); }
      });
    }
    /* C2: a consulta falhou duas vezes seguidas: diz na tela; some quando a rede volta */
    function avisoRede(liga) {
      var ret = q('retorno');
      if (liga && !semRede) { semRede = true; if (ret) ret.textContent = SEM_REDE; api.anunciar(SEM_REDE); }
      else if (!liga && semRede) { semRede = false; if (ret && ret.textContent === SEM_REDE) ret.textContent = ''; }
    }

    /* ----- vencido, recusado, devolvido -----
       semResposta (só no vencido): o relógio passou do prazo, mas o servidor não confirmou nada */
    function desenharFim(e, semResposta) {
      var t = FIM[e], h = api.faixaTeste(pix.modo, true);
      var txt = semResposta ? t.textoSemResposta : (op.comEquipe && t.textoEquipe ? t.textoEquipe : t.texto);
      if (comTitulo) h += '<p class="pix-titulo" data-pix="titulo" aria-hidden="true"></p>';
      h += '<p class="pix-texto">' + txt + '</p>';
      /* N10: sem resposta do servidor, o principal é conferir; gerar outro fica em segundo plano */
      if (semResposta) h += '<button type="button" class="pix-btn" data-pix="verificar">Já paguei, verificar agora</button>';
      h += '<button type="button" class="pix-btn' + (semResposta ? ' pix-btn--fantasma' : '') + '" data-pix="outro"><span data-rot>Gerar um novo Pix</span></button>';
      h += '<p class="pix-retorno" data-pix="retorno"></p>';
      if (op.zap && e !== 'estornado') h += '<a class="pix-btn pix-btn--fantasma" data-pix="zapConferir" href="#" target="_blank" rel="noopener" hidden>Falar com a equipe no WhatsApp</a>';
      h += (e === 'estornado' && op.zap)
        ? '<a class="pix-link" data-pix="zapDevolvido" href="#" target="_blank" rel="noopener">Falar com a equipe no WhatsApp</a>'
        : saidaHtml();
      el.innerHTML = '<div class="pix pix--fim" data-fase="' + e + '"' + (semResposta ? ' data-sem-resposta' : '') + '>' + h + '</div>';
      ligarZap('zapDevolvido', 'devolvido');
      ligarZap('zapConferir', 'nao_apareceu');
      ligarSaida();
      if (semResposta) q('verificar').addEventListener('click', function () { conferirDepois(this); });
      var b = q('outro');
      b.addEventListener('click', function () {
        if (desligado(b)) return;
        desligar(b, true); b.setAttribute('data-ocupado', '');
        b.querySelector('[data-rot]').textContent = 'Gerando o Pix...';
        api.anunciar('Gerando o Pix.');
        /* Pix vencido: antes de gerar outro, confere uma última vez se o antigo foi pago */
        var antes = e === 'expirado' ? api.status(pix.id, pix.token) : Promise.resolve(null);
        antes.then(function (r) {
          if (r && r.ok && r.status === 'aprovado') { aprovar(r); return; }
          /* B2: sem resposta certa do servidor, não gera outro (quem pagou no último minuto pagaria duas vezes) */
          if (e === 'expirado' && !(r && r.ok)) {
            desligar(b, false); b.removeAttribute('data-ocupado');
            b.querySelector('[data-rot]').textContent = 'Gerar um novo Pix';
            var ret = q('retorno');
            if (ret) ret.textContent = NAO_CONFERIU;
            zapConferir();
            api.anunciar(NAO_CONFERIU, true);
            return;
          }
          if (op.aoGerarOutro) op.aoGerarOutro();
        });
      });
    }
    /* o WhatsApp de "paguei e não apareceu"; a saída com o mesmo texto some, para não repetir o botão */
    function zapConferir() {
      var z = q('zapConferir'), sd = q('saida');
      if (!z) return;
      z.hidden = false;
      if (sd && sd.textContent === z.textContent) sd.hidden = true;
    }
    function fim(e, semResposta) {
      parar();
      estado = e;
      desenharFim(e, semResposta);
      titulo(e);
      api.anunciar(semResposta ? FIM[e].alertaSemResposta : FIM[e].alerta, true);
      mudou(e);
      api.aVista(el.firstChild);
    }
    /* "Já paguei, verificar agora" no vencido sem resposta: a consulta já parou, então pergunta direto */
    function conferirDepois(botao) {
      var ret = q('retorno');
      if (botao) { if (desligado(botao)) return; desligar(botao, true); botao.textContent = 'Verificando...'; }
      if (ret) ret.textContent = '';
      return api.status(pix.id, pix.token).then(function (r) {
        if (botao && botao.isConnected) { desligar(botao, false); botao.textContent = 'Já paguei, verificar agora'; }
        if (r.ok && r.status === 'aprovado') { aprovar(r); return; }
        if (r.ok && FIM[r.status]) { fim(r.status, false); return; }       /* agora o servidor respondeu: texto de sempre */
        if (!r.ok && (r.erro === 'token_invalido' || r.erro === 'nao_encontrado')) { if (op.aoFalhar) op.aoFalhar(r.erro); return; }
        /* N11: respondeu "pendente": o texto de "não conseguimos conferir" ficou velho; volta ao vencido de sempre */
        if (r.ok) fim('expirado', false);
        var msg = r.ok ? 'O pagamento ainda não apareceu. Se você pagou agora, espere 1 minuto e verifique de novo.'
                       : 'Não deu para verificar agora. Tente de novo em instantes. Se você já pagou, não pague outra vez.';
        var ret2 = q('retorno');
        if (ret2) ret2.textContent = msg;
        if (!r.ok) zapConferir();
        api.anunciar(msg);
      });
    }
    function aprovar(r) {
      parar();
      estado = 'aprovado';
      mudou('aprovado');
      if (api.centavos(r.valor) !== api.centavos(esperado)) {
        if (op.aoValorDiferente) op.aoValorDiferente(r);
        else if (op.aoFalhar) op.aoFalhar('valor_diferente');
      } else if (op.aoAprovar) op.aoAprovar(r);
    }

    /* ----- consulta ----- */
    function agendar(ms) {
      clearTimeout(timerPoll);
      if (parado || pausado || doc.hidden) return;
      timerPoll = setTimeout(consultar, ms);
    }
    function consultar() {
      if (parado) return Promise.resolve(null);
      if (emCurso) return emCurso;
      clearTimeout(timerPoll);
      emCurso = api.status(pix.id, pix.token).then(function (r) {
        emCurso = null;
        if (!parado && !pausado) tratar(r);
        return r;
      });
      return emCurso;
    }
    function tratar(r) {
      var venceu = Date.now() > expira;
      if (!r.ok) {
        if (r.erro === 'token_invalido' || r.erro === 'nao_encontrado') { parar(); if (op.aoFalhar) op.aoFalhar(r.erro); return; }
        falhas++;                              /* 429 muitas_tentativas também é passageiro: só recua */
        if (falhas >= 2 && r.erro !== 'muitas_tentativas') avisoRede(true);
        if (venceu && ++depois >= 3) { fim('expirado', true); return; }     /* B2: sem resposta, não afirma nada */
        agendar(Math.min(30000, INTERVALO * Math.pow(2, falhas)));      /* a rede falhou: recua */
        return;
      }
      falhas = 0;
      avisoRede(false);
      if (r.status === 'aprovado') { aprovar(r); return; }
      if (r.status === 'expirado' || r.status === 'recusado' || r.status === 'estornado') { fim(r.status); return; }
      if (venceu) { if (++depois >= 3) { fim('expirado'); return; } agendar(15000); return; }
      agendar(INTERVALO);
    }
    function tique() {
      if (parado) return;
      var agora = Date.now(), resta = expira - agora;
      var f = q('faltaTxt');
      if (f) {
        /* N7: o Pix vale 30 min e 30 s; a tela conta os 30 minutos que promete */
        var min = Math.max(1, Math.ceil((resta - 30000) / 60000)), txt = min > 1 ? 'Faltam ' + min + ' minutos' : 'Falta 1 minuto';
        if (f.textContent !== txt) f.textContent = txt;       /* muda a cada minuto, sem anunciar */
      }
      if (!avisou5 && resta <= 5 * 60000) { avisou5 = true; api.anunciar('Faltam 5 minutos para o Pix vencer.'); }
      if (!avisou1 && resta <= 60000) { avisou1 = true; api.anunciar('Falta 1 minuto.'); }
      var na = q('naoApareceu');
      if (na && na.hidden && agora - criadoEm > 3 * 60000) na.hidden = false;
      if (resta <= 0 && !vencendo && !pausado) { vencendo = true; consultar(); }
    }
    /* a pessoa foi ao app do banco e voltou: consulta na hora */
    function aoVer() {
      if (parado || pausado) return;
      if (doc.hidden) { clearTimeout(timerPoll); saiu = true; return; }
      if (saiu && estado === 'pix') fase('aguardando');
      saiu = false;
      consultar();
    }
    function parar() {
      parado = true;
      clearTimeout(timerPoll); clearInterval(timerTique);
      doc.removeEventListener('visibilitychange', aoVer);
      w.removeEventListener('pageshow', aoVer);
      avisarSim();
    }

    var ctrl = {
      estado: function () { return estado; },
      vivo: function () { return !parado; },
      verificar: function () { return consultar(); },
      pausar: function () { pausado = true; clearTimeout(timerPoll); },
      retomar: function () { if (parado) return; pausado = false; consultar(); },
      destruir: function () { if (!parado) parar(); if (ativo === ctrl) ativo = null; }
    };
    ativo = ctrl;

    desenharPix();
    titulo('pix');
    var vencidoAoAbrir = op.retomada && Date.now() > expira;
    if (vencidoAoAbrir) vencendo = true;      /* quem pergunta ao servidor é o conferirDepois, uma vez só */
    if (!op.retomada) api.anunciar('Pix gerado. Valor ' + valorTxt + '. Vale até ' + ate + '.');
    doc.addEventListener('visibilitychange', aoVer);
    w.addEventListener('pageshow', aoVer);
    timerTique = setInterval(tique, 1000);
    tique();
    mudou('pix');
    api.aVista(el.firstChild);
    if (vencidoAoAbrir) {
      /* B1: reabriu depois do prazo: mostra o vencido sem afirmar nada e pergunta ao servidor */
      fim('expirado', true);
      conferirDepois(null);
    } else if (op.retomada) {
      /* C1: quem reabre a página já foi pagar: entra esperando o pagamento e consulta na hora */
      fase('aguardando');
      consultar();
    } else agendar(INTERVALO);
    avisarSim();
    return ctrl;
  };

  w.SantoPix = api;
})(window);
