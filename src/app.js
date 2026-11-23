require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const routes = require('./routes');
const { tratarErros } = require('./utils/erros');

const app = express();

app.set('trust proxy', 1); // atrás do proxy HTTPS da nuvem: req.ip passa a ser o IP real
app.use(cors());
app.use(express.json());

// Arquivos estáticos (ex.: /leitor.html)
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  res.send('servidor ativo👌');
});

app.use(routes);
app.use(tratarErros);

module.exports = app;
