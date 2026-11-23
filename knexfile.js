require('dotenv').config();

// PostgreSQL em todos os ambientes (dev usa um banco online; testes usam um Postgres local temporário).
// DATABASE_URL: postgres://usuario:senha@host:5432/banco
// DB_SSL=false desliga o SSL (ex.: Postgres local). DB_SSL_REJECT_UNAUTHORIZED=false aceita
// certificado não verificado (só se o provedor exigir).
function conexao() {
  const usarSsl = process.env.DB_SSL !== 'false';
  return {
    connectionString: process.env.DATABASE_URL,
    ssl: usarSsl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false
  };
}

const base = {
  client: 'pg',
  pool: { min: 0, max: 10 },
  migrations: {
    directory: './src/database/migrations',
    tableName: 'knex_migrations'
  },
  seeds: {
    directory: './src/database/seeds'
  }
};

module.exports = {
  development: { ...base, connection: conexao() },
  test: { ...base, connection: conexao() },
  production: { ...base, connection: conexao() }
};
