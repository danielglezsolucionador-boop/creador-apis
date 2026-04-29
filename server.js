const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const SC_KEY = process.env.SCRAPECREATORS_API_KEY;
const DB_PATH = path.join(__dirname, 'db.json');
const CACHE_TTL = 60 * 60 * 1000; // 1 hora en ms

// ─── BASE DE DATOS JSON ───────────────────────────────────────────────────────
function leerDB() {
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ logs: [], stats: {}, cache: {}, apikeys: {} }));
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  if (!db.cache) db.cache = {};
  if (!db.apikeys) db.apikeys = {};
  return db;
}

function guardarDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function registrarLog(plataforma, keyword, resultados, error = null, cached = false) {
  const db = leerDB();
  const entry = {
    id: Date.now(),
    timestamp: new Date().toISOString(),
    plataforma,
    keyword,
    resultados: resultados || 0,
    error: error || null,
    creditos_usados: (error || cached) ? 0 : 1,
    cached
  };
  db.logs.unshift(entry);
  if (db.logs.length > 200) db.logs = db.logs.slice(0, 200);
  if (!db.stats[plataforma]) db.stats[plataforma] = { llamadas: 0, creditos: 0, errores: 0, cache_hits: 0 };
  db.stats[plataforma].llamadas++;
  if (cached) db.stats[plataforma].cache_hits++;
  else if (!error) db.stats[plataforma].creditos++;
  else db.stats[plataforma].errores++;
  guardarDB(db);
  return entry;
}

// ─── CACHÉ ────────────────────────────────────────────────────────────────────
function getCacheKey(plataforma, query) {
  return `${plataforma}:${query.toLowerCase().trim()}`;
}

function getCache(plataforma, query) {
  const db = leerDB();
  const key = getCacheKey(plataforma, query);
  const entry = db.cache[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    delete db.cache[key];
    guardarDB(db);
    return null;
  }
  return entry.datos;
}

function setCache(plataforma, query, datos) {
  const db = leerDB();
  const key = getCacheKey(plataforma, query);
  db.cache[key] = { timestamp: Date.now(), datos };
  // Limpiar cache viejo (max 500 entradas)
  const keys = Object.keys(db.cache);
  if (keys.length > 500) {
    const oldest = keys.sort((a, b) => db.cache[a].timestamp - db.cache[b].timestamp).slice(0, 100);
    oldest.forEach(k => delete db.cache[k]);
  }
  guardarDB(db);
}

// ─── API KEYS ─────────────────────────────────────────────────────────────────
function validarApiKey(req, res, next) {
  // Si REQUIRE_API_KEY no está activado, pasar directo
  if (process.env.REQUIRE_API_KEY !== 'true') return next();
  
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key) return res.status(401).json({ success: false, error: 'API key requerida. Header: x-api-key' });
  
  const db = leerDB();
  const keyData = db.apikeys[key];
  if (!keyData) return res.status(403).json({ success: false, error: 'API key inválida' });
  if (!keyData.activa) return res.status(403).json({ success: false, error: 'API key desactivada' });
  
  // Registrar uso en la key
  db.apikeys[key].ultimo_uso = new Date().toISOString();
  db.apikeys[key].llamadas = (db.apikeys[key].llamadas || 0) + 1;
  guardarDB(db);
  
  req.apiKeyData = keyData;
  next();
}

// ─── WRAPPERS SCRAPECREATORS ──────────────────────────────────────────────────
async function scTikTok(keyword) {
  const r = await axios.get('https://api.scrapecreators.com/v1/tiktok/search/top', {
    params: { query: keyword },
    headers: { 'x-api-key': SC_KEY },
    timeout: 30000
  });
  return (r.data?.items || []).slice(0, 10).map(i => ({
    titulo: i.desc || '',
    autor: i.author?.nickname || '',
    likes: i.statistics?.digg_count || 0,
    vistas: i.statistics?.play_count || 0,
    comentarios: i.statistics?.comment_count || 0,
    compartidos: i.statistics?.share_count || 0,
    url: `https://tiktok.com/@${i.author?.uniqueId}/video/${i.id}` || '',
    thumbnail: i.video?.cover || '',
    plataforma: 'tiktok'
  }));
}

async function scTwitterUsuario(handle) {
  const r = await axios.get('https://api.scrapecreators.com/v2/twitter/user/tweets', {
    params: { handle },
    headers: { 'x-api-key': SC_KEY },
    timeout: 30000
  });
  const tweets = r.data?.tweets || r.data?.data || [];
  return tweets.slice(0, 10).map(t => ({
    texto: t.text || t.full_text || t.legacy?.full_text || '',
    autor: handle,
    likes: t.favorite_count || t.legacy?.favorite_count || 0,
    retweets: t.retweet_count || t.legacy?.retweet_count || 0,
    url: `https://x.com/${handle}/status/${t.id || t.id_str || ''}`,
    fecha: t.created_at || '',
    plataforma: 'twitter'
  })).filter(t => t.texto.length > 5);
}

async function scLinkedIn(keyword) {
  const r = await axios.get('https://api.scrapecreators.com/v1/linkedin/search/posts', {
    params: { query: keyword },
    headers: { 'x-api-key': SC_KEY },
    timeout: 30000
  });
  const posts = r.data?.posts || r.data?.items || [];
  return posts.slice(0, 10).map(p => ({
    titulo: p.text?.substring(0, 100) || '',
    texto: p.text || '',
    autor: p.author?.name || '',
    likes: p.numLikes || 0,
    comentarios: p.numComments || 0,
    url: p.url || '',
    plataforma: 'linkedin'
  }));
}

async function scYouTube(keyword) {
  const r = await axios.get('https://api.scrapecreators.com/v1/youtube/search', {
    params: { query: keyword },
    headers: { 'x-api-key': SC_KEY },
    timeout: 30000
  });
  const items = r.data?.videos || r.data?.items || [];
  return items.slice(0, 10).map(i => ({
    titulo: i.title || '',
    canal: i.channelTitle || '',
    vistas: i.viewCount || 0,
    likes: i.likeCount || 0,
    url: `https://youtube.com/watch?v=${i.videoId || i.id}`,
    thumbnail: i.thumbnail || '',
    fecha: i.publishedAt || '',
    plataforma: 'youtube'
  }));
}

// ─── ENDPOINTS API ────────────────────────────────────────────────────────────

// POST /api/buscar — endpoint principal
app.post('/api/buscar', validarApiKey, async (req, res) => {
  const { keyword, plataforma, handle } = req.body;
  if (!keyword && !handle) return res.status(400).json({ success: false, error: 'keyword o handle requerido' });
  if (!plataforma) return res.status(400).json({ success: false, error: 'plataforma requerida' });

  const query = keyword || handle;

  // Verificar caché primero
  const cached = getCache(plataforma, query);
  if (cached) {
    registrarLog(plataforma, query, cached.length, null, true);
    return res.json({
      success: true, plataforma, keyword: query,
      total: cached.length, datos: cached,
      cached: true, timestamp: new Date().toISOString()
    });
  }

  try {
    let datos = [];
    switch (plataforma.toLowerCase()) {
      case 'tiktok':    datos = await scTikTok(query); break;
      case 'twitter':
      case 'x':         datos = await scTwitterUsuario(handle || query); break;
      case 'linkedin':  datos = await scLinkedIn(query); break;
      case 'youtube':   datos = await scYouTube(query); break;
      default: return res.status(400).json({ success: false, error: `Plataforma '${plataforma}' no soportada.` });
    }

    setCache(plataforma, query, datos);
    registrarLog(plataforma, query, datos.length);
    res.json({
      success: true, plataforma, keyword: query,
      total: datos.length, datos, cached: false,
      timestamp: new Date().toISOString()
    });

  } catch (e) {
    registrarLog(plataforma, query, 0, e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/plataformas
app.get('/api/plataformas', (req, res) => {
  res.json({
    success: true,
    plataformas: [
      { id: 'tiktok',   nombre: 'TikTok',    params: ['keyword'], creditos: 1 },
      { id: 'twitter',  nombre: 'X/Twitter', params: ['handle'],  creditos: 1 },
      { id: 'linkedin', nombre: 'LinkedIn',  params: ['keyword'], creditos: 1 },
      { id: 'youtube',  nombre: 'YouTube',   params: ['keyword'], creditos: 1 },
    ]
  });
});

// GET /api/logs
app.get('/api/logs', (req, res) => {
  const db = leerDB();
  const limit = parseInt(req.query.limit) || 50;
  res.json({ success: true, total: db.logs.length, logs: db.logs.slice(0, limit) });
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  const db = leerDB();
  const totalCreditos = Object.values(db.stats).reduce((sum, s) => sum + (s.creditos || 0), 0);
  const totalLlamadas = Object.values(db.stats).reduce((sum, s) => sum + (s.llamadas || 0), 0);
  const totalCacheHits = Object.values(db.stats).reduce((sum, s) => sum + (s.cache_hits || 0), 0);
  const cacheKeys = Object.keys(db.cache || {}).length;
  res.json({
    success: true,
    total_llamadas: totalLlamadas,
    total_creditos_usados: totalCreditos,
    total_cache_hits: totalCacheHits,
    cache_entradas_activas: cacheKeys,
    por_plataforma: db.stats
  });
});

// GET /api/cache/clear — limpiar caché manualmente
app.delete('/api/cache', (req, res) => {
  const db = leerDB();
  const total = Object.keys(db.cache || {}).length;
  db.cache = {};
  guardarDB(db);
  res.json({ success: true, message: `${total} entradas de caché eliminadas` });
});

// POST /api/keys — crear nueva API key (admin)
app.post('/api/keys', (req, res) => {
  const adminSecret = req.headers['x-admin-secret'];
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ success: false, error: 'No autorizado' });
  }
  const { nombre, plan } = req.body;
  const key = 'dk_' + Math.random().toString(36).substr(2, 16) + Date.now().toString(36);
  const db = leerDB();
  db.apikeys[key] = {
    nombre: nombre || 'Cliente',
    plan: plan || 'basic',
    activa: true,
    creada: new Date().toISOString(),
    ultimo_uso: null,
    llamadas: 0
  };
  guardarDB(db);
  res.json({ success: true, key, nombre, plan });
});

// GET / — dashboard
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});
const PORT = process.env.PORT || 3002;
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => console.log(`🚀 Creador de APIs corriendo en http://localhost:${PORT}`));
}