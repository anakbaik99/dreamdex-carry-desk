/**
 * Append-only ledger.
 *
 * Every decision the tool makes — scan, plan, open, close, protect, skip — is written here as one
 * JSON line, so the run can be reconstructed later and the evidence for a bounty submission
 * (orders, timestamps, venue responses) survives the process that produced it.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CONFIG } from './config.mjs';

export async function record(event) {
  const row = {
    ts: new Date().toISOString(),
    chainId: CONFIG.chainId,
    region: CONFIG.region,
    ...event,
  };
  await mkdir(dirname(CONFIG.ledgerPath), { recursive: true });
  await appendFile(CONFIG.ledgerPath, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

export async function readLedger() {
  try {
    const text = await readFile(CONFIG.ledgerPath, 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Group the ledger into the shape `report` prints. */
export function summariseLedger(rows) {
  const counts = {};
  const opens = [];
  const closes = [];
  let carryOpened = 0;

  for (const r of rows) {
    counts[r.event] = (counts[r.event] ?? 0) + 1;
    if (r.event === 'open' && r.ok) {
      opens.push(r);
      carryOpened += Number(r.dailyCarry ?? 0);
    }
    if (r.event === 'close' && r.ok) closes.push(r);
  }

  return { counts, opens, closes, carryOpened, total: rows.length };
}
