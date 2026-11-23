// Regras de "quem enxerga qual filial".
// admin (matriz): todas. Demais perfis: só as filiais de usuario_filiais.
const { ErroDeNegocio } = require('./erros');

function ehAdmin(req) {
  return req.usuario.perfil === 'admin';
}

// Filtra uma consulta pela coluna de filial (ex.: 'funcionarios.filial_id')
function noEscopo(query, req, coluna) {
  if (ehAdmin(req)) return query;
  return query.whereIn(coluna, req.usuario.filiais);
}

function podeAcessarFilial(req, filialId) {
  return ehAdmin(req) || req.usuario.filiais.includes(Number(filialId));
}

// Lança 403 se o usuário não atua na filial
function exigirFilial(req, filialId) {
  if (!podeAcessarFilial(req, filialId)) {
    throw new ErroDeNegocio(403, 'Você não tem acesso a esta filial');
  }
}

module.exports = { ehAdmin, noEscopo, podeAcessarFilial, exigirFilial };
