/**
 * Game server entry point.
 *
 * Responsibilities (Phase 0): boot Rapier in Node, expose health and a
 * determinism probe so clients can confirm their physics build matches ours.
 */
import { createServer } from 'node:http';
import { loadRapier, runDeterminismScenario } from '@tumble/sim';

const PORT = Number(process.env.PORT ?? 7350);

const R = await loadRapier();

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  // NOTE: the client dev server runs on a different port, so the debug probe needs CORS.
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rapier: R.version() }));
    return;
  }

  if (url.pathname === '/debug/determinism') {
    const steps = Math.min(Math.max(Number(url.searchParams.get('steps') ?? 600), 1), 10_000);
    const result = runDeterminismScenario(R, steps);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`[game-server] listening on :${PORT} (rapier ${R.version()})`);
});
