// PIN pessoal do funcionário: junto com o QR do crachá, vale como assinatura da entrega.
// Após MAX_FALHAS tentativas erradas, o PIN fica bloqueado por BLOQUEIO_MIN minutos.
const bcrypt = require('bcryptjs');
const knex = require('../database/db');
const { ErroDeNegocio } = require('../utils/erros');

const MAX_FALHAS = 5;
const BLOQUEIO_MIN = 15;

function validarFormato(pin) {
  const p = String(pin ?? '');
  if (!/^\d{4,6}$/.test(p)) throw new ErroDeNegocio(400, 'O PIN deve ter de 4 a 6 números');
  if (/^(\d)\1+$/.test(p)) throw new ErroDeNegocio(400, 'PIN fraco: não use todos os números iguais');
  const crescente = '0123456789012345';
  const decrescente = '9876543210987654';
  if (crescente.includes(p) || decrescente.includes(p)) throw new ErroDeNegocio(400, 'PIN fraco: não use sequências (ex.: 1234)');
  return p;
}

async function gerarHash(pin) {
  return bcrypt.hash(validarFormato(pin), 10);
}

// Confere o PIN numa transação própria: a contagem de falhas fica gravada mesmo se a entrega falhar depois.
async function conferirPin(funcionarioId, pin) {
  let resultado;
  await knex.transaction(async (trx) => {
    const f = await trx('funcionarios').where({ id: funcionarioId }).forUpdate()
      .first('pin_hash', 'pin_falhas', 'pin_bloqueado_ate');
    if (!f.pin_hash) {
      resultado = { erro: new ErroDeNegocio(409, 'Funcionário ainda não cadastrou o PIN', { codigo: 'PIN_NAO_DEFINIDO' }) };
      return;
    }
    if (f.pin_bloqueado_ate && new Date(f.pin_bloqueado_ate) > new Date()) {
      const ate = new Date(f.pin_bloqueado_ate).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
      resultado = { erro: new ErroDeNegocio(423, `PIN bloqueado por tentativas erradas até ${ate}`, { codigo: 'PIN_BLOQUEADO' }) };
      return;
    }
    if (pin === undefined || pin === null || pin === '') {
      resultado = { erro: new ErroDeNegocio(400, 'Informe o PIN do funcionário', { codigo: 'PIN_OBRIGATORIO' }) };
      return;
    }

    const ok = await bcrypt.compare(String(pin), f.pin_hash);
    if (ok) {
      await trx('funcionarios').where({ id: funcionarioId }).update({ pin_falhas: 0, pin_bloqueado_ate: null });
      resultado = { ok: true };
      return;
    }

    const falhas = f.pin_falhas + 1;
    if (falhas >= MAX_FALHAS) {
      await trx('funcionarios').where({ id: funcionarioId }).update({
        pin_falhas: 0,
        pin_bloqueado_ate: trx.raw(`now() + interval '${BLOQUEIO_MIN} minutes'`)
      });
      resultado = { erro: new ErroDeNegocio(423, `PIN incorreto. Bloqueado por ${BLOQUEIO_MIN} minutos`, { codigo: 'PIN_BLOQUEADO' }) };
    } else {
      await trx('funcionarios').where({ id: funcionarioId }).update({ pin_falhas: falhas });
      // 422 (não 401): 401 significaria sessão do técnico expirada
      resultado = { erro: new ErroDeNegocio(422, `PIN incorreto. Restam ${MAX_FALHAS - falhas} tentativas`, { codigo: 'PIN_INCORRETO' }) };
    }
  });
  if (resultado.erro) throw resultado.erro;
  return true;
}

module.exports = { validarFormato, gerarHash, conferirPin, MAX_FALHAS };
