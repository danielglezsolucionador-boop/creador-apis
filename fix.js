const fs = require('fs');
let c = fs.readFileSync('public/index.html', 'utf8');
c = c.replaceAll("fetch('/api/", "fetch('https://creador-apis.vercel.app/api/");
fs.writeFileSync('public/index.html', c);
console.log('listo');