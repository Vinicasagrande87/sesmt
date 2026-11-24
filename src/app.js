require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const knex = require('./database/db');
const { tratarErros } = require('./utils/erros');

const app = express();

app.set('trust proxy', 1); // atrás do proxy HTTPS da nuvem: req.ip passa a ser o IP real
app.use(cors());
// Corpo maior só nas rotas que recebem arquivo (foto da entrega, termo de adesão); o resto fica pequeno
app.use(['/entregas', '/funcionarios/:id/termo', '/certificados', '/asos', '/pgrs', '/ordens-servico'], express.json({ limit: '15mb' }));
app.use(express.json({ limit: '200kb' }));

// Arquivos estáticos (ex.: /leitor.html)
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  res.send('servidor ativo👌');
});

// Saúde do serviço (usada pelo monitoramento da hospedagem): não exige login e não expõe detalhes
app.get('/status', async (req, res) => {
  try {
    await knex.raw('select 1');
    return res.json({ api: 'ok', banco: 'ok' });
  } catch (error) {
    return res.status(503).json({ api: 'ok', banco: 'indisponível' });
  }
});

app.use(routes);
app.use(tratarErros);

module.exports = app;
