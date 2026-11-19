import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { RadarDatabase } from './src/server/radarDb';
import { RadarWorker } from './src/server/radarWorker';
import { StatsPeriod, TrafficCategory } from './src/types/radar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProduction = process.env.NODE_ENV === 'production';

function resolveServerPort(): number {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      const parsed = Number(args[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } else if (args[i].startsWith('--port=')) {
      const parsed = Number(args[i].slice('--port='.length));
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  const appPort = Number(process.env.APP_PORT);
  if (Number.isFinite(appPort) && appPort > 0) return appPort;
  const isAiStudioContainer = fs.existsSync('/app/control-plane-api');
  const envPort = Number(process.env.PORT);
  if (!isAiStudioContainer && Number.isFinite(envPort) && envPort > 0) {
    return envPort;
  }
  return 3000;
}

const PORT = resolveServerPort();
const DB_FILE = path.resolve(__dirname, 'src/data/steenwijkerland.db');
const FALLBACK_POLYGON_FILE = path.resolve(__dirname, 'src/data/steenwijkerlandPolygon.json');
const ADJACENT_POLYGONS_FILE = path.resolve(__dirname, 'src/data/adjacentMunicipalities.json');

const radarDb = new RadarDatabase(DB_FILE);
const radarWorker = new RadarWorker(radarDb, FALLBACK_POLYGON_FILE, ADJACENT_POLYGONS_FILE);

function buildLiveResponse() {
  const base = radarDb.getLiveRadarState();
  const approaching = radarWorker.getApproachingPassages();
  return {
    server_time_ms: Date.now(),
    health: {
      ...base.health,
      approaching_in_neighbors: approaching.length,
    },
    passages: base.passages,
    approaching_passages: approaching,
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  // 1. Gemeentegrens Steenwijkerland (GM1708 MultiPolygon)
  app.get('/api/radar/boundary', (_req, res) => {
    try {
      res.json(radarWorker.getBoundary());
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Fout bij ophalen GM1708 grens' });
    }
  });

  // 1b. Direct aangrenzende gemeenten (7 buurgemeenten van GM1708, puur voor visuele vooraankondiging)
  app.get('/api/radar/adjacent-boundaries', (_req, res) => {
    try {
      res.json(radarWorker.getAdjacentBoundaries());
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Fout bij ophalen buurgemeenten' });
    }
  });

  // 2. Actuele Live Radar State (actieve GM1708 vliegtuigen + naderende buurgemeente-toestellen + health)
  app.get('/api/radar/live', (_req, res) => {
    try {
      res.json(buildLiveResponse());
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Fout bij ophalen live radarstate' });
    }
  });

  // 3. Handmatige radar poll trigger
  app.post('/api/radar/poll-now', async (_req, res) => {
    try {
      const result = await radarWorker.pollOnce();
      res.json({ ...result, state: buildLiveResponse() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Poll mislukt' });
    }
  });

  // 4. Historische Replay Slice (max 600 passages)
  app.get('/api/radar/history', (req, res) => {
    try {
      const now = Date.now();
      const startParam = req.query.start ? String(req.query.start) : '';
      const endParam = req.query.end ? String(req.query.end) : '';

      const startMs = startParam ? new Date(startParam).getTime() : now - 3_600_000;
      const endMs = endParam ? new Date(endParam).getTime() : now;

      if (isNaN(startMs) || isNaN(endMs)) {
        return res.status(400).json({ error: 'Ongeldige start- of eindtijd' });
      }

      const minAltM = req.query.minAlt !== undefined ? Number(req.query.minAlt) : 0;
      const maxAltM = req.query.maxAlt !== undefined ? Number(req.query.maxAlt) : 20000;
      const includeUnknownAlt = req.query.includeUnknownAlt !== 'false';
      const catsRaw = req.query.categories ? String(req.query.categories).trim() : '';
      const categories = catsRaw
        ? (catsRaw.split(',').filter(Boolean) as TrafficCategory[])
        : null;

      const slice = radarDb.getHistoricalReplaySlice({
        startMs,
        endMs,
        minAltM: Number.isFinite(minAltM) ? minAltM : 0,
        maxAltM: Number.isFinite(maxAltM) ? maxAltM : 20000,
        categories,
        includeUnknownAlt,
      });

      const q = req.query.q ? String(req.query.q).trim().toLowerCase() : '';
      if (q) {
        slice.passages = slice.passages.filter(({ passage }) => {
          const hay = [
            passage.callsign,
            passage.registration,
            passage.icao24,
            passage.dep_iata,
            passage.dep_icao,
            passage.arr_iata,
            passage.arr_icao,
            passage.operator_name,
            passage.model_name,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return hay.includes(q);
        });
      }

      res.json(slice);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Fout bij ophalen historische passages' });
    }
  });

  // 5. Luchtverkeer Statistieken per periode (uur / 24u / 7d / weeknummer / alle historie)
  app.get('/api/radar/stats', (req, res) => {
    try {
      const p = String(req.query.period || 'day');
      const period = (
        ['hour', 'day', 'week', 'weeknum', 'all'].includes(p) ? p : 'day'
      ) as StatsPeriod;
      const weekKey = req.query.week ? String(req.query.week) : null;
      res.json(radarDb.getAirspaceStats(period, weekKey));
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Fout bij ophalen statistieken' });
    }
  });

  // 5b. Volledige historie heatmap van alle vliegsporen binnen GM1708
  app.get('/api/radar/heatmap', (_req, res) => {
    try {
      res.json(radarDb.getAllHistoryHeatmap());
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Fout bij opbouwen vliegspoor-heatmap' });
    }
  });

  // 6. CSV Export passages
  app.get('/api/radar/export.csv', (req, res) => {
    try {
      const p = String(req.query.period || 'day');
      const period = (
        ['hour', 'day', 'week', 'weeknum', 'all'].includes(p) ? p : 'day'
      ) as StatsPeriod;
      const weekKey = req.query.week ? String(req.query.week) : null;
      const csv = radarDb.exportPassagesCSV(period, weekKey);
      const suffix = period === 'weeknum' && weekKey ? `week-${weekKey}` : period;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="steenwijkerland-luchtverkeer-${suffix}-${new Date().toISOString().slice(0, 10)}.csv"`
      );
      res.send(csv);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'CSV export mislukt' });
    }
  });

  // 7. Persistente Backup & Restore API (IndexedDB / Cloud snapshot synchronisatie)
  app.get('/api/radar/backup', (req, res) => {
    try {
      if (req.query.idsOnly === '1') {
        const ids = radarDb.getBackupPassageIds();
        return res.json({ total: ids.length, ids });
      }
      const passages = radarDb.exportAllPassagesForBackup(5000);
      res.json({ total: passages.length, passages });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Fout bij ophalen backup' });
    }
  });

  app.post('/api/radar/restore', (req, res) => {
    try {
      const incoming = req.body?.passages;
      if (!Array.isArray(incoming)) {
        return res.status(400).json({ error: 'passages array ontbreekt' });
      }
      const restored = radarDb.restorePassages(incoming);
      if (restored > 0) {
        radarDb.saveBackupFile();
      }
      const total = radarDb.getBackupPassageIds().length;
      res.json({ ok: true, restored, total });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Herstellen van historie mislukt' });
    }
  });

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', radar: radarDb.getHealth() });
  });

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const srv = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Steenwijkerland Luchtverkeer Radar Server gestart op http://0.0.0.0:${PORT}`);
    radarWorker.start();
  });

  const backupFlushTimer = setInterval(() => {
    radarDb.flushBackupIfDirty();
  }, 15_000);
  backupFlushTimer.unref();

  let shuttingDown = false;
  const gracefulShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Ontvangen ${signal}, radar worker & historiebackup worden veilig weggeschreven...`);
    clearInterval(backupFlushTimer);
    radarWorker.stop();
    try {
      radarDb.flushBackupIfDirty();
    } catch {}
    try {
      srv.close(() => {
        try {
          radarDb.flushBackupIfDirty();
          radarDb.db.close();
        } catch {}
        process.exit(0);
      });
      setTimeout(() => {
        try {
          radarDb.flushBackupIfDirty();
          radarDb.db.close();
        } catch {}
        process.exit(0);
      }, 2000).unref();
    } catch {
      process.exit(0);
    }
  };

  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

startServer().catch((err) => {
  console.error('Fout bij starten radar server:', err);
});
