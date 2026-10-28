/**
 * NUMA · Servidor de notificaciones push y API de juegos
 */

const express = require('express');
const cors = require('cors');
const { Expo } = require('expo-server-sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const PORT = process.env.PORT || 3000;
const EXPO_ACCESS_TOKEN = process.env.EXPO_ACCESS_TOKEN || undefined;
const COUNTRY = (process.env.COUNTRY || 'EC').toUpperCase();
const LOCALE = process.env.LOCALE || 'es-EC';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60000);

const EPIC_URL =
  `https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions` +
  `?locale=${encodeURIComponent(LOCALE)}&country=${encodeURIComponent(COUNTRY)}&allowCountries=${encodeURIComponent(COUNTRY)}`;

const TOKENS_FILE = path.join(__dirname, 'tokens.json');
const SEEN_FILE = path.join(__dirname, 'seen.json');

const expo = new Expo({ accessToken: EXPO_ACCESS_TOKEN });

/** token -> { platform, country, updatedAt } */
const tokens = new Map();
/** Set de gameId ya notificados */
const seenGames = new Set();
/** Caché de detalles completos (requisitos) -> gameId: { systemRequirements } */
const gameDetailsCache = new Map();

function load() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(data)) tokens.set(k, v);
    }
  } catch (e) {
    console.error('[load tokens]', e);
  }
  try {
    if (fs.existsSync(SEEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
      for (const id of data) seenGames.add(id);
    }
  } catch (e) {
    console.error('[load seen]', e);
  }
}

function saveTokens() {
  try {
    const obj = {};
    for (const [k, v] of tokens.entries()) obj[k] = v;
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('[save tokens]', e);
  }
}

function saveSeen() {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify([...seenGames], null, 2));
  } catch (e) {
    console.error('[save seen]', e);
  }
}

// ---------- Endpoints ----------

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'numa-server' });
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    tokens: tokens.size,
    seen: seenGames.size,
    country: COUNTRY,
    pollIntervalMs: POLL_INTERVAL_MS,
    now: new Date().toISOString(),
  });
});

app.post('/register', (req, res) => {
  const { token, platform, country } = req.body || {};
  if (!token || !Expo.isExpoPushToken(token)) {
    return res.status(400).json({ ok: false, error: 'token Expo inválido' });
  }
  tokens.set(token, {
    platform: platform || 'unknown',
    country: (country || COUNTRY).toUpperCase(),
    updatedAt: Date.now(),
  });
  saveTokens();
  console.log(`[register] ${platform || '?'} tokens=${tokens.size}`);
  res.json({ ok: true });
});

app.post('/unregister', (req, res) => {
  const { token } = req.body || {};
  if (token && tokens.delete(token)) saveTokens();
  res.json({ ok: true });
});

// Endpoint para que la app obtenga la lista de juegos con requisitos
let latestGames = [];
app.get('/games', (_req, res) => {
  // Combinamos la lista base con los detalles cacheados
  const enrichedGames = latestGames.map(g => ({
    ...g,
    ...(gameDetailsCache.get(g.id) || {}),
  }));
  res.json({ ok: true, games: enrichedGames, updatedAt: Date.now() });
});

// ---------- Epic Games ----------

function buildStoreUrl(el) {
  const slug =
    el.productSlug ||
    el.urlSlug ||
    (el.catalogNs && el.catalogNs.mappings && el.catalogNs.mappings[0] && el.catalogNs.mappings[0].pageSlug) ||
    el.id;
  const clean = String(slug).replace(/\/home$/, '');
  return `https://store.epicgames.com/${LOCALE}/p/${clean}`;
}

async function fetchFreeGames() {
  const res = await fetch(EPIC_URL, {
    headers: { 'User-Agent': 'Numa/1.0 (+server)' },
  });
  if (!res.ok) throw new Error(`Epic HTTP ${res.status}`);
  const data = await res.json();
  const elements = data?.data?.Catalog?.searchStore?.elements || [];

  const free = [];
  for (const el of elements) {
    const groups = el.promotions?.promotionalOffers || [];
    for (const group of groups) {
      const offers = group.promotionalOffers || [];
      for (const o of offers) {
        if (o.discountSetting?.discountPercentage === 0) {
          free.push({
            id: String(el.id),
            title: el.title,
            description: el.description,
            publisher: el.seller?.name || 'Desconocido',
            image: el.keyImages?.find(img => img.type === 'Thumbnail')?.url || el.keyImages?.[0]?.url,
            originalPrice: el.price?.totalPrice?.fmtPrice?.originalPrice,
            url: buildStoreUrl(el),
            start: el.promotions?.upcomingPromotionalOffers?.[0]?.promotionalOffers?.[0]?.startDate || new Date().toISOString(),
            end: o.endDate,
          });
        }
      }
    }
  }
  const byId = new Map();
  for (const g of free) byId.set(g.id, g);
  return [...byId.values()];
}

async function fetchGameRequirements(gameId) {
  const query = `
    query searchStoreQuery($id: String!, $country: String!, $locale: String!) {
      Catalog {
        searchStore(id: $id, country: $country, locale: $locale) {
          elements {
            id
            systemRequirements {
              minimum { os processor memory graphics storage }
              recommended { os processor memory graphics storage }
            }
          }
        }
      }
    }
  `;
  try {
    const res = await fetch('https://graphql.epicgames.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { id: gameId, country: COUNTRY, locale: LOCALE },
      }),
    });
    const json = await res.json();
    const element = json?.data?.Catalog?.searchStore?.elements?.[0];
    return element?.systemRequirements || null;
  } catch (e) {
    console.error(`[requirements] Error para ${gameId}:`, e);
    return null;
  }
}

// ---------- Ciclo de notificaciones ----------

let checking = false;

async function checkAndNotify() {
  if (checking) return;
  checking = true;
  try {
    const free = await fetchFreeGames();
    latestGames = free; // Guardamos la última lista

    // Buscamos requisitos para juegos que no estén en caché
    for (const g of free) {
      if (!gameDetailsCache.has(g.id)) {
        const reqs = await fetchGameRequirements(g.id);
        if (reqs) {
          gameDetailsCache.set(g.id, { systemRequirements: reqs });
        }
      }
    }

    const newGames = free.filter((g) => !seenGames.has(g.id));

    if (newGames.length === 0) {
      console.log(`[check] ${free.length} gratis, 0 nuevos`);
      return;
    }

    for (const g of newGames) seenGames.add(g.id);
    saveSeen();
    console.log(`[check] ${free.length} gratis, ${newGames.length} nuevos`);

    if (tokens.size === 0) {
      console.log('[push] sin dispositivos registrados');
      return;
    }

    const messages = [];
    for (const token of tokens.keys()) {
      if (!Expo.isExpoPushToken(token)) {
        tokens.delete(token);
        continue;
      }
      for (const g of newGames) {
        messages.push({
          to: token,
          sound: 'default',
          title: '¡Juego gratis en Epic!',
          body: g.title,
          data: { gameId: g.id, url: g.url },
          priority: 'high',
          channelId: 'numa-alerts',
        });
      }
    }
    saveTokens();

    if (messages.length === 0) return;

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        const receipts = await expo.sendPushNotificationsAsync(chunk);
        receipts.forEach((r, i) => {
          if (r.status === 'error' && r.details?.error === 'DeviceNotRegistered') {
            const dead = chunk[i]?.to;
            if (dead) tokens.delete(dead);
          }
        });
      } catch (e) {
        console.error('[push chunk error]', e);
      }
    }
    saveTokens();
    console.log(`[push] enviados ${messages.length} mensajes a ${tokens.size} dispositivos`);
  } catch (e) {
    console.error('[checkAndNotify]', e);
  } finally {
    checking = false;
  }
}

// ---------- Arranque ----------

load();
checkAndNotify();
setInterval(checkAndNotify, POLL_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`Numa server escuchando en http://0.0.0.0:${PORT}`);
  console.log(`País: ${COUNTRY} · Locale: ${LOCALE} · Poll: ${POLL_INTERVAL_MS}ms`);
});