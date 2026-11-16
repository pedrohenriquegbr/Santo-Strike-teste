/* /api/tagme-reserva/ : adaptador fino. A lógica está em _lib/rotas.js. Formato (req, res) em CommonJS:
   funciona na Vercel sem package.json e sem build. */
'use strict';
const { criarRota } = require('./_lib/adaptador');
const rotas = require('./_lib/rotas');

module.exports = criarRota(rotas.tagmeReserva, { metodos: ['POST'], lerCorpo: true, limite: { nome: 'tagme-reserva', envMax: 'PIX_LIMITE_TAGME', max: 10, janelaMs: 10 * 60 * 1000 } });
