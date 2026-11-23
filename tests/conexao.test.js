// Teste de conexão com o banco (npm run db:testar) e rota GET /status.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { iniciarAmbiente } = require('./ambiente');

const SCRIPT = path.join(__dirname, '..', 'src', 'database', 'testar-conexao.js');
const SENHA = 'postgres';

let amb;

before(async () => {
  amb = await iniciarAmbiente();
  await amb.criarBanco('banco_vazio'); // banco sem migrations aplicadas
});

after(async () => {
  if (amb) await amb.encerrar();
});

// Roda o script num processo separado, com o ambiente informado
function rodar(env) {
  return new Promise((resolve) => {
    const filho = spawn(process.execPath, [SCRIPT], {
      cwd: path.join(__dirname, '..'),
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, NODE_ENV: 'test', DB_TESTE_TIMEOUT_MS: '5000', ...env }
    });
    let saida = '';
    filho.stdout.on('data', (d) => { saida += d; });
    filho.stderr.on('data', (d) => { saida += d; });
    filho.on('close', (codigo) => resolve({ codigo, saida }));
  });
}

const url = (resto) => `postgres://postgres:${SENHA}@localhost:${amb.porta}/${resto}`;

test('conexão OK: mostra versão, SSL e migrations, sem mostrar a senha', async () => {
  const r = await rodar({ DATABASE_URL: url('sesmt_test'), DB_SSL: 'false' });
  assert.equal(r.codigo, 0, r.saida);
  assert.match(r.saida, /✔ Conexão OK/);
  assert.match(r.saida, /PostgreSQL 17/);
  assert.match(r.saida, /criptografada \(SSL\): NÃO/);
  assert.match(r.saida, /Migrations: \d+ aplicadas, 0 pendentes/);
  assert.match(r.saida, /usuário: postgres/);
  assert.ok(!r.saida.includes(`:${SENHA}@`), 'a senha não pode aparecer');
});

test('banco sem migrations: lista as pendentes', async () => {
  const r = await rodar({ DATABASE_URL: url('banco_vazio'), DB_SSL: 'false' });
  assert.equal(r.codigo, 0, r.saida);
  assert.match(r.saida, /0 aplicadas, [1-9]\d* pendentes/);
  assert.match(r.saida, /npx knex migrate:latest/);
});

test('DATABASE_URL vazia ou mal formada', async () => {
  const vazia = await rodar({ DATABASE_URL: '' });
  assert.equal(vazia.codigo, 1);
  assert.match(vazia.saida, /DATABASE_URL está vazia/);

  const quebrada = await rodar({ DATABASE_URL: 'isso nao e uma url' });
  assert.equal(quebrada.codigo, 1);
  assert.match(quebrada.saida, /mal formada/);
});

test('senha errada', async () => {
  const r = await rodar({ DATABASE_URL: `postgres://postgres:senha-errada@localhost:${amb.porta}/sesmt_test`, DB_SSL: 'false' });
  assert.equal(r.codigo, 1);
  assert.match(r.saida, /Usuário ou senha incorretos/);
  assert.ok(!r.saida.includes('senha-errada'), 'a senha não pode aparecer');
});

test('banco inexistente', async () => {
  const r = await rodar({ DATABASE_URL: url('nao_existe'), DB_SSL: 'false' });
  assert.equal(r.codigo, 1);
  assert.match(r.saida, /não existe nesse servidor/);
});

test('porta fechada', async () => {
  const r = await rodar({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x', DB_SSL: 'false' });
  assert.equal(r.codigo, 1);
  assert.match(r.saida, /Conexão recusada/);
});

test('servidor inexistente', async () => {
  const r = await rodar({ DATABASE_URL: 'postgres://u:p@servidor-que-nao-existe.invalid:5432/x', DB_SSL: 'false' });
  assert.equal(r.codigo, 1);
  assert.match(r.saida, /Servidor não encontrado|Sem resposta/);
});

test('SSL ligado num servidor sem SSL', async () => {
  const r = await rodar({ DATABASE_URL: url('sesmt_test') }); // DB_SSL padrão = ligado
  assert.equal(r.codigo, 1);
  assert.match(r.saida, /não usa SSL/);
});

test('GET /status: público e informa o banco', async () => {
  const r = await amb.chamar('GET', '/status');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { api: 'ok', banco: 'ok' });
});
