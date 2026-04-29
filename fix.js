const fs = require('fs');
let c = fs.readFileSync('server.js', 'utf8');
c = c.replace("express.static('.')", "express.static('public')");
c = c.replace("'/index.html'", "'/public/index.html'");
fs.writeFileSync('server.js', c);
console.log('listo');