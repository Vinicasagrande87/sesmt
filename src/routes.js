const express = require('express');
const routes = express.Router();

const FuncionarioController = require('./controllers/FuncionarioController');
const EpiController = require('./controllers/EpiController');
const EntregaController = require('./controllers/EntregaController');
const AcidenteController = require('./controllers/AcidenteController');
const TreinamentoController = require('./controllers/TreinamentoController');
const CertificadoController = require('./controllers/CertificadoController');
const EstoqueController = require('./controllers/EstoqueController');

routes.get('/ping', (req, res) => res.json({ message: 'pong' }));

// Rotas existentes
routes.get('/funcionarios', FuncionarioController.index);
routes.post('/funcionarios', FuncionarioController.create);
routes.get('/epis', EpiController.index);
routes.post('/epis', EpiController.create);
routes.get('/entregas', EntregaController.index);
routes.post('/entregas', EntregaController.create);

// Novas Rotas
routes.get('/acidentes', AcidenteController.index);
routes.post('/acidentes', AcidenteController.create);

routes.get('/treinamentos', TreinamentoController.index);
routes.post('/treinamentos', TreinamentoController.create);

routes.get('/certificados', CertificadoController.index);
routes.post('/certificados', CertificadoController.create);

routes.get('/estoque', EstoqueController.index);
routes.post('/estoque', EstoqueController.create);

module.exports = routes;