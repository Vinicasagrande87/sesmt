// Cria (ou redefine a senha de) um usuário admin direto no banco.
// Uso: npm run criar-admin -- "Nome" email@empresa.com "senha-forte"
require('dotenv').config();
const bcrypt = require('bcryptjs');
const knex = require('./db');
const { validarSenha } = require('../utils/senha');

async function main() {
  const [nome, email, senha] = process.argv.slice(2);
  if (!nome || !email || !senha) {
    console.error('Uso: npm run criar-admin -- "Nome" email@empresa.com "senha-forte"');
    process.exitCode = 1;
    return;
  }
  try {
    validarSenha(senha, email);
  } catch (erro) {
    console.error(erro.message);
    process.exitCode = 1;
    return;
  }

  const emailNormalizado = email.trim().toLowerCase();
  const senha_hash = await bcrypt.hash(senha, 10);
  const existente = await knex('usuarios').where({ email: emailNormalizado }).first('id');

  if (existente) {
    // Senha nova: as sessões abertas desse usuário caem
    await knex('usuarios').where({ id: existente.id })
      .update({ nome, senha_hash, perfil: 'admin', ativo: true, sessao_versao: knex.raw('sessao_versao + 1'), senha_alterada_em: knex.fn.now() });
    console.log(`Admin atualizado: ${emailNormalizado}`);
  } else {
    await knex('usuarios').insert({ nome, email: emailNormalizado, senha_hash, perfil: 'admin' });
    console.log(`Admin criado: ${emailNormalizado}`);
  }
}

main()
  .catch((e) => { console.error('Erro:', e.message); process.exitCode = 1; })
  .finally(() => knex.destroy());
