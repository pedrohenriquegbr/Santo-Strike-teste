/* /api/mp-webhook/ : adaptador fino. A lógica está em _lib/rotas.js. Formato (req, res) em CommonJS:
   funciona na Vercel sem package.json e sem build. */
'use strict';
const { criarRota } = require('./_lib/adaptador');
const rotas = require('./_lib/rotas');

module.exports = criarRota(rotas.mpWebhook, { metodos: ['POST'], lerCorpo: true, semOrigem: true });
