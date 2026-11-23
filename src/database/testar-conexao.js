// Testa a conexão com o banco configurado no .env (DATABASE_URL).
// Uso: npm run db:testar
// Nunca mostra a senha. Sai com código 1 se algo falhar.
require('dotenv').config();

const TIMEOUT_MS = Number(process.env.DB_TESTE_TIMEOUT_MS) || 10000;

// Explica em português os erros mais comuns de conexão
function explicar(erro) {
  const msg = String(erro && erro.message || erro);
  const codigo = erro && erro.code;
  if (codigo === 'ENOTFOUND' || codigo === 'EAI_AGAIN') return 'Servidor não encontrado: confira o endereço (host) na DATABASE_URL e a sua internet.';
  if (codigo === 'ECONNREFUSED') return 'Conexão recusada: o servidor existe, mas não aceita conexões nessa porta. Confira a porta e se o banco está ligado.';
  if (codigo === 'ETIMEDOUT' || /timeout/i.test(msg)) return `Sem resposta em ${TIMEOUT_MS / 1000}s: firewall, rede da empresa bloqueando a porta, ou banco em pausa (alguns planos gratuitos "dormem").`;
  if (codigo === '28P01' || /password authentication failed/i.test(msg)) return 'Usuário ou senha incorretos.';
  if (codigo === '3D000') return 'O banco informado no final da DATABASE_URL não existe nesse servidor.';
  if (codigo === '28000' && /no pg_hba\.conf entry|SSL off/i.test(msg)) return 'O servidor exige SSL: não use DB_SSL=false.';
  if (/does not support SSL|server does not support/i.test(msg)) return 'Esse servidor não usa SSL: defina DB_SSL=false no .env (normal só em Postgres local).';
  if (/self[- ]signed|unable to verify|certificate/i.test(msg)) return 'Certificado SSL não verificado. Se o provedor orientar, defina DB_SSL_REJECT_UNAUTHORIZED=false.';
  if (codigo === '53300' || /too many connections/i.test(msg)) return 'Limite de conexões do banco atingido.';
  return null;
}

// Mostra a URL sem a senha
function descreverUrl(texto) {
  const url = new URL(texto);
  return {
    host: url.hostname,
    porta: url.port || '5432',
    banco: url.pathname.replace(/^\//, '') || '(padrão)',
    usuario: decodeURIComponent(url.username) || '(não informado)'
  };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('✖ DATABASE_URL está vazia no .env.');
    console.error('  Cole a connection string do provedor: postgres://usuario:senha@host:5432/banco');
    return 1;
  }

  let destino;
  try {
    destino = descreverUrl(url);
  } catch {
    console.error('✖ DATABASE_URL mal formada. Formato esperado: postgres://usuario:senha@host:5432/banco');
    return 1;
  }

  console.log('Testando conexão com o banco...');
  console.log(`  host: ${destino.host}  porta: ${destino.porta}  banco: ${destino.banco}  usuário: ${destino.usuario}`);
  console.log(`  SSL: ${process.env.DB_SSL === 'false' ? 'desligado (DB_SSL=false)' : 'ligado'}`);

  const knex = require('knex')({
    ...require('../../knexfile')[process.env.NODE_ENV || 'development'],
    acquireConnectionTimeout: TIMEOUT_MS
  });

  try {
    const inicio = Date.now();
    const { rows: [info] } = await knex.raw(`
      select version() as versao,
             current_database() as banco,
             current_user as usuario,
             now() as agora,
             coalesce((select ssl from pg_stat_ssl where pid = pg_backend_pid()), false) as ssl
    `);
    const latencia = Date.now() - inicio;

    console.log(`✔ Conexão OK (${latencia} ms)`);
    console.log(`  ${String(info.versao).split(',')[0]}`);
    console.log(`  conectado como "${info.usuario}" no banco "${info.banco}"`);
    console.log(`  conexão criptografada (SSL): ${info.ssl ? 'sim' : 'NÃO'}`);
    if (!info.ssl && process.env.NODE_ENV === 'production') {
      console.log('  ⚠ Em produção a conexão deveria ser criptografada.');
    }

    const [concluidas, pendentes] = await knex.migrate.list();
    console.log(`✔ Migrations: ${concluidas.length} aplicadas, ${pendentes.length} pendentes`);
    if (pendentes.length) {
      console.log('  Para aplicar: npx knex migrate:latest');
      for (const p of pendentes) console.log(`   - ${p.file}`);
    }
    return 0;
  } catch (erro) {
    console.error('✖ Falha ao conectar.');
    const dica = explicar(erro);
    if (dica) console.error(`  ${dica}`);
    console.error(`  Detalhe técnico: ${erro.code ? `[${erro.code}] ` : ''}${erro.message}`);
    return 1;
  } finally {
    await knex.destroy();
  }
}

main().then((codigo) => { process.exitCode = codigo; });
