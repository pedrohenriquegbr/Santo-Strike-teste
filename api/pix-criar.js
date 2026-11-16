/* /api/pix-criar/ : adaptador fino. A lógica está em _lib/rotas.js. Formato (req, res) em CommonJS:
   funciona na Vercel sem package.json e sem build. */
'use strict';
const { criarRota } = require('./_lib/adaptador');
const rotas = require('./_lib/rotas');

module.exports = criarRota(rotas.pixCriar, { metodos: ['POST'], lerCorpo: true, limite: { nome: 'pix-criar', envMax: 'PIX_LIMITE_CRIAR', max: 8, janelaMs: 10 * 60 * 1000 } });
