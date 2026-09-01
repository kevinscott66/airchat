import * as SQLite from 'expo-sqlite';
import { log } from '../../logger';

export type RelayNode = {
  did: string;
  location: { lat: number; lon: number };
  range: number;
  transports: string[];
  lastSeen: number;
};

type LatLon = { lat: number; lon: number };

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function getGeoDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const database = await SQLite.openDatabaseAsync('airchat_georouter.db');
      await database.execAsync(`
        CREATE TABLE IF NOT EXISTS geo_relays (
          did TEXT PRIMARY KEY NOT NULL,
          lat REAL NOT NULL,
          lon REAL NOT NULL,
          range_km REAL NOT NULL,
          transports TEXT NOT NULL,
          last_seen INTEGER NOT NULL
        );
      `);
      return database;
    })();
  }
  return dbPromise;
}

/**
 * Географическая маршрутизация по ретрансляторам: граф + Дейкстра, персистенция в SQLite.
 */
export class GeographicRouter {
  private readonly relays = new Map<string, RelayNode>();
  private myLocation: LatLon | null = null;

  constructor(
    private readonly getTargetLocation?: (
      did: string
    ) => Promise<{ location: LatLon } | null>
  ) {}

  setMyLocation(loc: LatLon | null): void {
    this.myLocation = loc;
  }

  async updateMyLocation(getCoords: () => Promise<LatLon>): Promise<void> {
    try {
      this.myLocation = await getCoords();
    } catch (e) {
      console.error('[GeoRouter] Failed to get location:', e);
    }
  }

  /** Загрузить ретрансляторы из SQLite в память. */
  async hydrateFromDb(): Promise<void> {
    try {
      const d = await getGeoDb();
      const rows = await d.getAllAsync<{
        did: string;
        lat: number;
        lon: number;
        range_km: number;
        transports: string;
        last_seen: number;
      }>('SELECT did, lat, lon, range_km, transports, last_seen FROM geo_relays');
      for (const row of rows ?? []) {
        let transports: string[] = [];
        try {
          // v4.32.200 (Round-30 #6): cap + shape-check row.transports.
          // Corrupt or attacker-seeded row (imported via topology) could
          // otherwise inflate arrays feeding downstream route selection.
          if (typeof row.transports === 'string' && row.transports.length <= 4096) {
            const parsed = JSON.parse(row.transports) as unknown;
            if (Array.isArray(parsed) && parsed.length <= 32) {
              transports = parsed.filter((t): t is string => typeof t === 'string' && t.length <= 64);
            }
          }
        } catch {
          transports = [];
        }
        this.relays.set(row.did, {
          did: row.did,
          location: { lat: row.lat, lon: row.lon },
          range: row.range_km,
          transports,
          lastSeen: row.last_seen,
        });
      }
    } catch (e) {
      log.warn('geo_router_hydrate_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  addRelay(relay: RelayNode): void {
    this.relays.set(relay.did, relay);
    void this.persistRelay(relay);
  }

  mergeTopology(peers: RelayNode[]): void {
    for (const p of peers) this.addRelay(p);
  }

  getRelays(): RelayNode[] {
    return [...this.relays.values()];
  }

  private async persistRelay(relay: RelayNode): Promise<void> {
    try {
      const d = await getGeoDb();
      await d.runAsync(
        `INSERT OR REPLACE INTO geo_relays (did, lat, lon, range_km, transports, last_seen)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          relay.did,
          relay.location.lat,
          relay.location.lon,
          relay.range,
          JSON.stringify(relay.transports),
          relay.lastSeen,
        ]
      );
    } catch (e) {
      log.warn('geo_router_persist_failed', {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async findPath(targetDid: string): Promise<RelayNode[]> {
    if (!this.myLocation) return [];
    let targetLoc: LatLon | null = null;
    if (this.getTargetLocation) {
      const t = await this.getTargetLocation(targetDid);
      targetLoc = t?.location ?? null;
    }
    if (!targetLoc) {
      const tr = this.relays.get(targetDid);
      targetLoc = tr?.location ?? null;
    }
    if (!targetLoc) return [];

    const startRelay = this.findNearestRelay(this.myLocation);
    const targetRelay = this.findNearestRelay(targetLoc);
    if (!startRelay || !targetRelay) return [];
    if (startRelay.did === targetRelay.did) return [startRelay];

    const graph = this.buildDirectedGraph();
    return this.dijkstraPath(graph, startRelay.did, targetRelay.did);
  }

  private buildDirectedGraph(): Map<string, Map<string, number>> {
    const graph = new Map<string, Map<string, number>>();
    for (const [did, node] of this.relays) {
      const edges = new Map<string, number>();
      for (const [otherDid, other] of this.relays) {
        if (did === otherDid) continue;
        const d = this.haversineKm(node.location, other.location);
        if (d <= node.range) {
          edges.set(otherDid, d);
        }
      }
      graph.set(did, edges);
    }
    return graph;
  }

  private dijkstraPath(
    graph: Map<string, Map<string, number>>,
    startId: string,
    goalId: string
  ): RelayNode[] {
    const dist = new Map<string, number>();
    const prev = new Map<string, string | null>();
    const q = new Set<string>();

    for (const id of graph.keys()) {
      dist.set(id, Infinity);
      prev.set(id, null);
      q.add(id);
    }
    dist.set(startId, 0);

    while (q.size > 0) {
      let u: string | null = null;
      let best = Infinity;
      for (const id of q) {
        const d = dist.get(id) ?? Infinity;
        if (d < best) {
          best = d;
          u = id;
        }
      }
      if (u === null || best === Infinity) break;
      q.delete(u);
      if (u === goalId) break;

      const neigh = graph.get(u);
      if (!neigh) continue;
      for (const [v, w] of neigh) {
        if (!q.has(v)) continue;
        const alt = (dist.get(u) ?? Infinity) + w;
        if (alt < (dist.get(v) ?? Infinity)) {
          dist.set(v, alt);
          prev.set(v, u);
        }
      }
    }

    if ((dist.get(goalId) ?? Infinity) === Infinity) return [];

    const path: string[] = [];
    let cur: string | null = goalId;
    while (cur) {
      path.unshift(cur);
      cur = prev.get(cur) ?? null;
    }
    return path.map((id) => this.relays.get(id)).filter((n): n is RelayNode => !!n);
  }

  private findNearestRelay(location: LatLon): RelayNode | null {
    let nearest: RelayNode | null = null;
    let minDistance = Infinity;
    for (const relay of this.relays.values()) {
      const distance = this.haversineKm(location, relay.location);
      if (distance <= relay.range && distance < minDistance) {
        minDistance = distance;
        nearest = relay;
      }
    }
    return nearest;
  }

  private haversineKm(a: LatLon, b: LatLon): number {
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const x =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
    const c = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    return R * c;
  }
}
