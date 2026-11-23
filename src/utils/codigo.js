// Código de verificação curto (entregas, presenças, certificados)
const crypto = require('crypto');

const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O e 1/I/L, para não confundir

function gerarCodigo() {
  let codigo = '';
  for (let i = 0; i < 8; i++) codigo += ALFABETO[crypto.randomInt(ALFABETO.length)];
  return codigo;
}

module.exports = { gerarCodigo };
