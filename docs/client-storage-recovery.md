# Client storage and synchronization recovery

Required local schema migrations run before indexes and before the database is
returned to application code. A failed migration closes that connection and
preserves the database file. Retrying boot repeats idempotent column migrations;
a partially completed ALTER sequence is not treated as a usable schema.
`src/core/storage/localBootstrap.ts` owns connection failure cleanup and final
index creation; migration definitions remain in `local.ts`.

A failed incoming sync projection does not advance its cursor. The client shows
an incomplete-sync indicator and retries the same snapshot after the underlying
storage/key/validation problem is resolved. A successful probe of another
SQLite database cannot establish that a feed database or encryption key works.
There is no automatic quarantine/skip path: a permanently invalid record blocks
that profile's pull until the source data or client is repaired.

A lost successful push response can cause a retry with the same mutation id and
new randomized ciphertext. Only HTTP 409 with `sync_mutation_conflict` triggers a
recovery pull. The rejected bytes are never marked accepted; normal authenticated
projection reconciles the stored snapshot, then remaining local changes are
collected again. Other request errors remain failures.

Album items and their parent albums are independent full snapshots. Orphan
cleanup waits until the last pull page, including when the local orphan grace
period has elapsed. An intermediate page cannot establish that a parent is absent.

## Historical server journal loss

Servers using the former ACK-based journal cleanup may already have removed the
ciphertext referenced by an entity head. Keeping current snapshots prevents
future cleanup loss; it cannot recreate ciphertext previously deleted.

Use the following **read-only** diagnostic against a backup or a read-only SQLite
connection. It returns metadata only; it does not reset cursors, epochs or rows.

```sql
PRAGMA query_only = ON;
SELECT h.account_id, COUNT(*) AS missing_snapshots,
       MAX(h.revision) AS highest_missing_revision
FROM sync_entity_heads AS h
LEFT JOIN sync_mutations AS m
  ON m.account_id = h.account_id AND m.sequence = h.sequence
WHERE m.sequence IS NULL
GROUP BY h.account_id;
```

An empty result confirms that each current head has a stored snapshot; it is not
a cryptographic integrity check. For a nonempty result, preserve server backups
and surviving device copies before selecting a repair strategy. Do not clear
heads or automatically reset epochs: local deleted-head metadata also represents
locally suppressed orphan cleanup, so it cannot safely reconstruct every signed
deletion. Historical recovery must distinguish live snapshots, authentic
tombstones and local-only suppression. If neither a backup nor a surviving device
has the required content, the server cannot recover it.
