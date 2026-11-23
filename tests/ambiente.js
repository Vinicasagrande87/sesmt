// Sobe um PostgreSQL temporário (embedded-postgres), roda as migrations e inicia a API numa porta livre.
// Nada encosta no banco online: tudo é criado numa pasta temporária e apagado no fim.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const bcrypt = require('bcryptjs');

function portaLivre() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function iniciarAmbiente() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'sesmt-pg-'));
  const porta = await portaLivre();
  const pg = new EmbeddedPostgres({
    databaseDir: pasta,
    port: porta,
    user: 'postgres',
    password: 'postgres',
    persistent: false,
    onLog: () => {},
    onError: () => {}
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('sesmt_test');

  // Precisa estar definido antes de carregar o knexfile/db.js
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = `postgres://postgres:postgres@localhost:${porta}/sesmt_test`;
  process.env.DB_SSL = 'false';
  process.env.JWT_SECRET = 'segredo-de-teste';

  const knex = require('../src/database/db');
  await knex.migrate.latest();

  const app = require('../src/app');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;

  // Chamada HTTP: devolve { status, body, headers }
  async function chamar(metodo, url, { token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const resp = await fetch(base + url, {
      method: metodo,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const tipo = resp.headers.get('content-type') || '';
    const corpo = tipo.includes('json') ? await resp.json() : await resp.arrayBuffer();
    return { status: resp.status, body: corpo, headers: resp.headers };
  }

  async function criarUsuarioNoBanco({ nome, email, senha, perfil, filiais = [] }) {
    const [u] = await knex('usuarios')
      .insert({ nome, email, senha_hash: await bcrypt.hash(senha, 4), perfil })
      .returning('id');
    if (filiais.length) await knex('usuario_filiais').insert(filiais.map((f) => ({ usuario_id: u.id, filial_id: f })));
    return u.id;
  }

  async function login(email, senha) {
    const r = await chamar('POST', '/auth/login', { body: { email, senha } });
    if (r.status !== 200) throw new Error(`login falhou para ${email}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.token;
  }

  async function encerrar() {
    server.closeAllConnections(); // o fetch mantém conexões keep-alive abertas
    await new Promise((resolve) => server.close(resolve));
    await knex.destroy();
    await pg.stop();
    fs.rmSync(pasta, { recursive: true, force: true });
  }

  return { knex, base, porta, criarBanco: (nome) => pg.createDatabase(nome), chamar, login, criarUsuarioNoBanco, encerrar };
}

module.exports = { iniciarAmbiente };
