require('dotenv').config();

const app = require('./app');
const knex = require('./database/db');
const { selarAuditoria } = require('./services/integridade');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`servidor trabalhando na porta ${PORT} 🚀`);
});

// Garantia: sela a cada minuto o que tiver ficado de fora (ex.: servidor reiniciado no meio)
const selar = () => selarAuditoria(knex).catch((erro) => console.warn(`Selagem da auditoria adiada: ${erro.message}`));
selar();
setInterval(selar, 60 * 1000).unref();

// Avisos de vencimento por e-mail (semanal, 1 mês de antecedência)
require('./services/avisos').iniciarAgendador(knex);
