// Grava no log de auditoria quem fez o quê, com os dados antes e depois.
// Use dentro da mesma transação da alteração: se a alteração falhar, o log também some.

const { marcarPendente } = require('../services/integridade');

// Nunca vão para o log (segredos e chaves de acesso)
const CAMPOS_OCULTOS = ['senha_hash', 'pin_hash', 'qr_token'];

function limpar(dados) {
  if (!dados) return null;
  const copia = { ...dados };
  for (const campo of CAMPOS_OCULTOS) {
    if (campo in copia) copia[campo] = '[oculto]';
  }
  return copia;
}

async function auditar(trx, req, { acao, tabela, registro_id, filial_id, antes, depois }) {
  await trx('auditoria').insert({
    usuario_id: req.usuario ? req.usuario.id : null,
    acao,
    tabela,
    registro_id: registro_id == null ? null : String(registro_id),
    filial_id: filial_id ?? null,
    antes: antes ? JSON.stringify(limpar(antes)) : null,
    depois: depois ? JSON.stringify(limpar(depois)) : null,
    ip: req.ip || null
  });
  marcarPendente(); // a linha entra na cadeia de hash logo depois que a requisição termina
}

module.exports = { auditar };
