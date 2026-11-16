/* /api/pix-cancelar/ : adaptador fino. A lógica está em _lib/rotas.js. Formato (req, res) em CommonJS:
   funciona na Vercel sem package.json e sem build.
   D9: a tela chama ao largar um Pix pendente; o Mercado Pago cancela e ninguém paga um Pix sem tela.
   Limite por IP: 20 chamadas a cada 10 minutos (uma por Pix largado). PIX_LIMITE_CANCELAR, ou a de teste PIX_LIMITE_CRIAR, afrouxa no servidor local. */
'use strict';
const { criarRota } = require('./_lib/adaptador');
const rotas = require('./_lib/rotas');

module.exports = criarRota(rotas.pixCancelar, { metodos: ['POST'], lerCorpo: true, limite: { nome: 'pix-cancelar', envMax: ['PIX_LIMITE_CANCELAR', 'PIX_LIMITE_CRIAR'], max: 20, janelaMs: 10 * 60 * 1000 } });
