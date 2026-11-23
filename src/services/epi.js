const { ErroDeNegocio } = require('../utils/erros');
const { hoje } = require('../utils/datas');

// CA válido hoje (o de validade mais longa). Lança 409 explicando o motivo se não houver.
async function caVigente(trx, epiId) {
  const cas = await trx('epi_cas').where({ epi_id: epiId }).orderBy('validade', 'desc');
  if (!cas.length) throw new ErroDeNegocio(409, 'EPI sem CA cadastrado: entrega bloqueada');

  const dataHoje = hoje();
  const vigente = cas.find((c) => c.validade && c.validade >= dataHoje);
  if (vigente) return vigente;

  const comValidade = cas.find((c) => c.validade);
  if (comValidade) {
    throw new ErroDeNegocio(409, `CA ${comValidade.numero} vencido em ${comValidade.validade}: entrega bloqueada`);
  }
  throw new ErroDeNegocio(409, `CA ${cas[0].numero} sem validade cadastrada: entrega bloqueada`);
}

// Item ativo de EPI ativo (com os dados do EPI)
async function itemAtivo(trx, itemId) {
  const item = await trx('epi_itens')
    .join('epis', 'epis.id', 'epi_itens.epi_id')
    .where('epi_itens.id', itemId)
    .first('epi_itens.id', 'epi_itens.epi_id', 'epi_itens.tamanho', 'epi_itens.ativo as item_ativo',
      'epis.nome', 'epis.ativo as epi_ativo', 'epis.validade_dias', 'epis.unidade');
  if (!item || !item.item_ativo || !item.epi_ativo) throw new ErroDeNegocio(404, 'Item de EPI não encontrado ou inativo');
  return item;
}

module.exports = { caVigente, itemAtivo };
