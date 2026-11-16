/* /api/pix-status/ : adaptador fino. A lógica está em _lib/rotas.js. Formato (req, res) em CommonJS:
   funciona na Vercel sem package.json e sem build.
   Limite por IP: 60 chamadas por minuto (a tela consulta a cada 4 s). PIX_LIMITE_STATUS, ou a de teste PIX_LIMITE_CRIAR, afrouxa no servidor local. */
'use strict';
const { criarRota } = require('./_lib/adaptador');
const rotas = require('./_lib/rotas');

module.exports = criarRota(rotas.pixStatus, { metodos: ['GET'], limite: { nome: 'pix-status', envMax: ['PIX_LIMITE_STATUS', 'PIX_LIMITE_CRIAR'], max: 60, janelaMs: 60 * 1000 } });
