const express = require('express');
const routes = express.Router(); // Esta linha DEVE vir antes das rotas

// Importação dos Controllers
const FuncionarioController = require('./controllers/FuncionarioController');
const EpiController = require('./controllers/EpiController');
const EntregaController = require('./controllers/EntregaController');

// Rota de Teste
routes.get('/ping', (req, res) => res.json({ message: 'pong' }));

// --- ROTAS DE FUNCIONÁRIOS ---
routes.get('/funcionarios', FuncionarioController.index);
routes.post('/funcionarios', FuncionarioController.create);
routes.delete('/funcionarios/:id', FuncionarioController.delete);

// --- ROTAS DE EPIS ---
routes.get('/epis', EpiController.index);
routes.post('/epis', EpiController.create);
routes.delete('/epis/:id', EpiController.delete);

// --- ROTAS DE ENTREGAS ---
routes.get('/entregas', EntregaController.index);
routes.post('/entregas', EntregaController.create);

module.exports = routes;