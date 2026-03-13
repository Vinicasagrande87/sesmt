require ('dotenv').config();

const express = require('express');
const routes = require('./routes');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/',(req,res)=>{
    res.send('servidor ativo👌')
});

app.use(routes);

app.listen(PORT,()=>{
    console.log(`servidor trabalhando na porta${PORT}🚀`)
});

module.exports = app;