/**
 * The Dukascopy downloader against a local stand-in server serving day files in Dukascopy's
 * format (LZMA-compressed 24-byte candles). The candles are TEST fixtures, not market data.
 * Checks the decoding, the manifest, and resuming: a failed day is fetched again on the next run
 * and nothing else is.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSide } from '../src';

const SCRIPT = resolve(import.meta.dirname, '../scripts/dukascopy_download.py');
const SERVER = `
import datetime as dt, http.server, lzma, os, struct, sys
root = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        with open(os.path.join(root, 'requests.log'), 'a') as f: f.write(self.path + '\\n')
        pair, y, m, d, name = self.path.strip('/').split('/')
        day = dt.date(int(y), int(m) + 1, int(d))
        side = name.split('_')[0]
        if os.path.exists(os.path.join(root, 'FAIL')) and day.day == 3 and side == 'ASK':
            self.send_response(500); self.end_headers(); return
        if day.weekday() >= 5:
            self.send_response(404); self.end_headers(); return
        base = 110000 + day.day * 100 + (2 if side == 'ASK' else 0)
        recs = b''.join(struct.pack('>5I f', k * 60, base + k, base + k + 3, base + k - 2, base + k + 5, 1.5) for k in range(3))
        body = lzma.compress(recs, format=lzma.FORMAT_ALONE)
        self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
print(srv.server_address[1], flush=True)
srv.serve_forever()
`;

let root: string;
let server: ChildProcess;
let base: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'astra-dl-'));
  server = spawn('python3', ['-c', SERVER, root], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<string>((ok) =>
    server.stdout!.once('data', (d: Buffer) => ok(d.toString().trim())),
  );
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.kill();
  rmSync(root, { recursive: true, force: true });
});

const download = (out: string, ...extra: string[]) => {
  const r = spawnSync(
    'python3',
    [
      SCRIPT,
      ...['--pairs', 'EURUSD', '--from', '2024-01-01', '--to', '2024-01-08'],
      ...['--out', join(root, out), '--retries', '0', '--base-url', base, ...extra],
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    },
  );
  return { status: r.status, out: r.stdout + r.stderr };
};
const requests = () =>
  existsSync(join(root, 'requests.log'))
    ? readFileSync(join(root, 'requests.log'), 'utf8').trim().split('\n').filter(Boolean)
    : [];

describe('Dukascopy downloader', () => {
  it('resumes: a failed day is fetched again on the next run, nothing else is', () => {
    writeFileSync(join(root, 'FAIL'), '');
    const first = download('data');
    expect(first.status).toBe(1);
    expect(first.out).toMatch(/NOT COMPLETE: 13 of 14 day files/);
    expect(existsSync(join(root, 'data', 'manifest.json'))).toBe(false);

    rmSync(join(root, 'FAIL'));
    rmSync(join(root, 'requests.log'));
    const second = download('data');
    expect(second.status).toBe(0);
    expect(requests()).toEqual(['/EURUSD/2024/00/03/ASK_candles_min_1.bi5']);
    expect(second.out).toMatch(/COMPLETE: data and manifest.json/);
    expect(existsSync(join(root, 'data', '.cache'))).toBe(false);

    // Decoded as the research tool reads it: 5 weekdays × 3 candles, UTC, 5-digit prices.
    const csv = readFileSync(join(root, 'data', 'eurusd-bid.csv'), 'utf8');
    expect(csv.split('\n')[1]).toBe('1704067200000,1.10100,1.10105,1.10098,1.10103,1.5');
    const { bars, reports } = loadSide([{ name: 'bid', text: csv }], { format: 'dukascopy' });
    expect(reports[0]).toMatchObject({ parsed: 15, invalid: 0 });
    // The three M1 candles of each day make one M5 candle (00:00–00:05).
    expect(bars).toHaveLength(5);
    expect(bars[0]).toMatchObject({
      t: Date.parse('2024-01-01T00:00:00Z'),
      o: 1.101,
      h: 1.10107,
      l: 1.10098,
      c: 1.10105,
    });
    expect(JSON.parse(readFileSync(join(root, 'data', 'manifest.json'), 'utf8'))).toEqual({
      pairs: {
        EURUSD: {
          format: 'dukascopy',
          side: 'BID',
          files: ['eurusd-bid.csv'],
          askFiles: ['eurusd-ask.csv'],
        },
      },
    });
    const log = JSON.parse(readFileSync(join(root, 'data', 'download-log.json'), 'utf8')) as {
      pairs: Record<string, Record<string, { candles: number; weekdaysMissing: number }>>;
    };
    expect(log.pairs.EURUSD!.ASK).toMatchObject({ candles: 15, weekdaysMissing: 0 });

    rmSync(join(root, 'requests.log'));
    const third = download('data');
    expect(third.status).toBe(0);
    expect(third.out).toMatch(/already downloaded/);
    expect(requests()).toEqual([]);
  }, 60_000);

  it('stops cleanly at --max-minutes and says to run it again', () => {
    const r = download('timed', '--max-minutes', '0');
    expect(r.status).toBe(3);
    expect(r.out).toMatch(/NOT COMPLETE: 0 of 14 day files\. Run the same command again/);
  }, 60_000);
});
