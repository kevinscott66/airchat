/**
 * Реестр юзернеймов: захват, конфликт, переименование и справка.
 *
 * Отдельный процесс с собственной базой — `sync-api.test.js` закрывает свою в
 * `t.after`, и делить одну на два файла нельзя.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash, randomBytes } = require('crypto');
const test = require('node:test');
const { ed25519 } = require('@noble/curves/ed25519.js');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-username-'));
process.env.CLOUD_VAULT_DIR = dataDir;
process.env.SYNC_DB_FILE = path.join(dataDir, 'sync.sqlite');
const { app, syncDb } = require('./index');
const { RESERVED_USERNAMES, normalizeClaimableUsername } = require('./reserved-usernames');

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function accountFor(fill) {
  const privateKey = new Uint8Array(32).fill(fill);
  const publicKey = ed25519.getPublicKey(privateKey);
  return {
    privateKey,
    publicKeyB64: Buffer.from(publicKey).toString('base64'),
    accountId: createHash('sha256').update(Buffer.from(publicKey)).digest('hex').slice(0, 32),
  };
}

function signed(account, op, overrides = {}) {
  const payload = {
    v: 1,
    op,
    accountId: account.accountId,
    publicKeyB64: account.publicKeyB64,
    accountPublicKeyB64: account.publicKeyB64,
    devicePublicKeyB64: account.publicKeyB64,
    deviceId: 'phone-1',
    deviceLabel: 'Test phone',
    deviceInfo: { platform: 'ios', model: 'Test iPhone', osVersion: '18.6', appVersion: '4.32.543' },
    timestamp: Date.now(),
    nonce: randomBytes(16).toString('base64url'),
    ...overrides,
  };
  const raw = JSON.stringify(canonicalize(payload));
  return {
    payload: raw,
    signature: Buffer.from(ed25519.sign(Buffer.from(raw), account.privateKey)).toString('base64'),
  };
}

test('username registry claims globally and refuses a name held by another account', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    syncDb.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const alice = accountFor(11);
  const bob = accountFor(12);

  const post = async (account, body) => fetch(`${base}/v1/sync/${account.accountId}/username/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  for (const account of [alice, bob]) {
    const enroll = await fetch(`${base}/v1/sync/${account.accountId}/devices/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signed(account, 'enroll')),
    });
    assert.equal(enroll.status, 200);
  }

  const free = await fetch(`${base}/v1/username/kevin_s`);
  assert.equal(free.status, 200);
  assert.deepEqual(await free.json(), { username: 'kevin_s', taken: false, pub: null, name: null, kind: null, id: null });

  const claim = await post(alice, signed(alice, 'claim_username', { username: 'kevin_s', ownerProfileId: 0 }));
  assert.equal(claim.status, 200);
  assert.deepEqual(await claim.json(), { ok: true, username: 'kevin_s' });

  const taken = await fetch(`${base}/v1/username/KEVIN_S`);
  // Имя занято, но ключа при захвате не предъявляли — владелец не назван.
  assert.deepEqual(await taken.json(), { username: 'kevin_s', taken: true, pub: null, name: null, kind: 'account', id: null });

  // Чужой аккаунт то же имя не получает.
  const conflict = await post(bob, signed(bob, 'claim_username', { username: 'kevin_s', ownerProfileId: 0 }));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'username_taken');

  // Свой же профиль повторно занимает то же имя без ошибки (идемпотентность).
  const again = await post(alice, signed(alice, 'claim_username', { username: 'kevin_s', ownerProfileId: 0 }));
  assert.equal(again.status, 200);

  // Переименование освобождает прежнее имя — иначе за каждым копились бы
  // брошенные записи.
  const renamed = await post(alice, signed(alice, 'claim_username', { username: 'kevin_s2', ownerProfileId: 0 }));
  assert.equal(renamed.status, 200);
  assert.equal((await (await fetch(`${base}/v1/username/kevin_s`)).json()).taken, false);
  const rescued = await post(bob, signed(bob, 'claim_username', { username: 'kevin_s', ownerProfileId: 0 }));
  assert.equal(rescued.status, 200);

  // Второй профиль той же seed-фразы — отдельный владелец имени.
  const second = await post(alice, signed(alice, 'claim_username', { username: 'kevin_s3', ownerProfileId: 1 }));
  assert.equal(second.status, 200);
  assert.equal((await (await fetch(`${base}/v1/username/kevin_s2`)).json()).taken, true);

  // Оставленные приложению и слишком короткие имена сервер не принимает даже
  // от собранного вручную клиента.
  for (const username of ['support', 'abc', 'Плохое', 'a'.repeat(33)]) {
    const rejected = await post(alice, signed(alice, 'claim_username', { username, ownerProfileId: 0 }));
    assert.equal(rejected.status, 401, `expected refusal for ${username}`);
  }

  // v4.32.548: оставленное приложению имя открывает подписанная бумага на
  // галочку — но именно подписанная. Самодельная, пустая и чрезмерно длинная
  // получают тот же отказ, что и запрос вовсе без неё: сервер проверяет
  // подпись сам, а не верит присланному «мне разрешено».
  const forged = JSON.stringify({
    payload: JSON.stringify({ did: 'did:key:z6Mk', kind: 'official', username: 'founder', v: 1 }),
    signature: Buffer.alloc(64).toString('base64'),
  });
  for (const badge of [forged, '', 'x'.repeat(2000), 42]) {
    const rejected = await post(alice, signed(alice, 'claim_username', {
      username: 'founder', ownerProfileId: 0, badge,
    }));
    assert.equal(rejected.status, 401, `expected refusal for badge ${String(badge).slice(0, 12)}`);
  }
  assert.equal((await (await fetch(`${base}/v1/username/founder`)).json()).taken, false);

  // Освобождение по запросу владельца.
  const release = await fetch(`${base}/v1/sync/${alice.accountId}/username/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signed(alice, 'release_username', { ownerProfileId: 1 })),
  });
  assert.equal(release.status, 200);
  assert.equal((await (await fetch(`${base}/v1/username/kevin_s3`)).json()).taken, false);

  // v4.32.607: справочник имён. Ключ профиля кладётся не на слово — подпись
  // под привязкой делается ЭТИМ ключом, а не ключом аккаунта, которым
  // подписан сам запрос. Иначе владелец имени направил бы своё @name на
  // чужой ключ: у дополнительных профилей ключ переписки другой.
  const profileSecret = new Uint8Array(32).fill(42);
  const profilePublicKeyB64 = Buffer.from(ed25519.getPublicKey(profileSecret)).toString('base64');
  const binding = (username, pid) =>
    Buffer.from(`airchat-username-directory:v1:${username}:${alice.accountId}:${pid}`, 'utf8');
  const proofBy = (secret, msg) => Buffer.from(ed25519.sign(msg, secret)).toString('base64');

  // Свой адрес для этой части: общий потолок запросов — 30 в минуту на адрес,
  // и проверка справочника не должна упираться в него вместе с остальными.
  const dirHeaders = { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' };
  const postDir = (body) => fetch(`${base}/v1/sync/${alice.accountId}/username/claim`, {
    method: 'POST', headers: dirHeaders, body: JSON.stringify(body),
  });
  const lookupDir = (name) => fetch(`${base}/v1/username/${name}`, { headers: dirHeaders });

  const badProofs = [
    // Подпись ключом аккаунта под чужим (профильным) ключом.
    proofBy(alice.privateKey, binding('alice_dir', 0)),
    // Своя подпись, но под ДРУГИМ именем того же аккаунта: привязка именная.
    proofBy(profileSecret, binding('alice_other', 0)),
    // Своя подпись под другим номером профиля.
    proofBy(profileSecret, binding('alice_dir', 1)),
  ];
  for (const profileProof of badProofs) {
    const rejected = await postDir(signed(alice, 'claim_username', {
      username: 'alice_dir', ownerProfileId: 0, profilePublicKeyB64, profileProof,
    }));
    assert.equal(rejected.status, 401, 'expected refusal for a proof that does not bind');
  }
  // Ключ без подписи вовсе — отказ, а не «положим на слово».
  const noProof = await postDir(signed(alice, 'claim_username', {
    username: 'alice_dir', ownerProfileId: 0, profilePublicKeyB64,
  }));
  assert.equal(noProof.status, 401);
  assert.equal((await (await lookupDir('alice_dir')).json()).taken, false);

  // Своя подпись под своим именем — имя занято, ключ опубликован.
  const published = await postDir(signed(alice, 'claim_username', {
    username: 'alice_dir', ownerProfileId: 0,
    profilePublicKeyB64, profileProof: proofBy(profileSecret, binding('alice_dir', 0)),
  }));
  assert.equal(published.status, 200);
  assert.deepEqual(await (await lookupDir('ALICE_DIR')).json(), {
    username: 'alice_dir', taken: true, pub: profilePublicKeyB64, name: null, kind: 'account', id: null,
  });

  // v4.32.722: имя владельца. Приходит очищенным от меток направления письма
  // и управляющих символов; повтор захвата старым клиентом (без имени) его не
  // стирает; не-строка — отказ.
  const claimAs = (extra) => postDir(signed(alice, 'claim_username', {
    username: 'alice_dir', ownerProfileId: 0,
    profilePublicKeyB64, profileProof: proofBy(profileSecret, binding('alice_dir', 0)),
    ...extra,
  }));
  assert.equal((await claimAs({ displayName: '  \u202EРита\u0000 ' })).status, 200);
  assert.equal((await (await lookupDir('alice_dir')).json()).name, 'Рита');
  assert.equal((await claimAs({})).status, 200);
  assert.equal((await (await lookupDir('alice_dir')).json()).name, 'Рита');
  assert.equal((await claimAs({ displayName: 'М'.repeat(60) })).status, 200);
  assert.equal((await (await lookupDir('alice_dir')).json()).name, 'М'.repeat(40));
  assert.equal((await claimAs({ displayName: 42 })).status, 401);

  const malformed = await fetch(`${base}/v1/username/${encodeURIComponent('нет')}`);
  assert.equal(malformed.status, 400);
});

test('server reserved list matches the client one', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'core', 'identity', 'reservedUsernames.ts'),
    'utf8',
  );
  const block = source.slice(
    source.indexOf('RESERVED_USERNAMES: ReadonlySet<string> = new Set(['),
    source.indexOf(']);'),
  );
  const clientNames = new Set([...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]));
  assert.ok(clientNames.size > 50, 'client list parsed');
  assert.deepEqual([...clientNames].sort(), [...RESERVED_USERNAMES].sort());
  assert.equal(normalizeClaimableUsername(' @Kevin_S '), 'kevin_s');
  assert.equal(normalizeClaimableUsername('support'), null);
  // Сверка выше видит только СПИСОК имён: правило, записанное регулярным
  // выражением, для неё невидимо — так и разъехалось `digits_only`. Полную
  // сверку ответов обеих сторон делает jest-тест клиента
  // `src/core/identity/__tests__/usernameServerMirror.test.ts`; здесь —
  // короткая страховка на тот же случай.
  assert.equal(normalizeClaimableUsername('12345'), null);
  assert.equal(normalizeClaimableUsername('12345', '12345'), null);
  assert.equal(normalizeClaimableUsername('a12345'), 'a12345');
});


/**
 * Справочник имён (v4.32.607): по @name отдаётся открытый ключ профиля — тот,
 * которым этот профиль переписывается, — и только он.
 *
 * Проверяется главное: ключ кладётся не на слово. Подпись под привязкой
 * делается ЭТИМ ключом, а не ключом аккаунта, которым подписан сам запрос, —
 * иначе владелец имени направил бы своё @name на чужой ключ.
 */
test('username directory publishes the profile key only with its own proof', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-username-dir-'));
  const dbFile = path.join(dir, 'sync.sqlite');
  const { SyncDatabase } = require('./sync-db');
  const db = new SyncDatabase(dbFile);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const owner = accountFor(21);
  db.ensureAccount(owner.accountId, owner.publicKeyB64);

  const profileKey = Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(31))).toString('base64');
  assert.equal(db.claimUsername(owner.accountId, 0, 'directory_one', profileKey).ok, true);
  assert.equal(db.lookupUsername('directory_one').profilePublicKeyB64, profileKey);

  // Повторный захват без ключа не стирает уже опубликованный.
  assert.equal(db.claimUsername(owner.accountId, 0, 'directory_one', null).ok, true);
  assert.equal(db.lookupUsername('directory_one').profilePublicKeyB64, profileKey);

  // Свободного имени в справочнике нет вовсе.
  assert.equal(db.lookupUsername('directory_two'), null);
});

test('справка по имени описана у своего маршрута, а не у чужого', () => {
  // Комментарий к `/v1/username/:username` объясняет единственный запрос
  // реестра без подписи и то, что ответ раскрывает ключ профиля. После
  // v4.32.612 между ним и маршрутом вклинилась выкладка публикаций, и читатель
  // получал разбор ответов taken/pub над кодом, который отдаёт конверт поста.
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const doc = src.indexOf(' * Справка по имени');
  const route = src.indexOf("app.get('/v1/username/:username'");
  assert.ok(doc > 0, 'комментарий на месте');
  assert.ok(route > doc, 'маршрут ниже комментария');
  assert.ok(!src.slice(doc, route).includes('app.'), 'между ними нет другого маршрута');
});

/**
 * Дефект: пространств имён было два. Юзернейм человека лежал в реестре, а
 * «публичный адрес» группы — нигде: его писал себе каждый сам, конвертом
 * `meta`. Поэтому `@x` одновременно носили человек, группа и канал, и
 * приглашение «пиши на @x» не значило ничего.
 *
 * Цена: адрес — единственная человекочитаемая вывеска, по которой в
 * приложение приходят снаружи. Канал, назвавшийся адресом чужого канала,
 * ничем от него не отличался.
 *
 * Правка (v4.32.937): адрес занимается тем же `claimUsername`, в том же
 * реестре, с предметом — публичным идентификатором `GR-…`/`CH-…`.
 *
 * Границы: предмет НЕ доказывает, что заявитель владеет группой — своей
 * ключевой пары у группы нет. Он даёт уникальность и отделяет слот адреса от
 * слота личного имени: занимает их один и тот же профиль.
 */
test('пространство имён одно: человек, группа и канал спорят за одну строку', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airchat-username-space-'));
  const { SyncDatabase } = require('./sync-db');
  const db = new SyncDatabase(path.join(dir, 'sync.sqlite'));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const alice = accountFor(41);
  const bob = accountFor(42);
  db.ensureAccount(alice.accountId, alice.publicKeyB64);
  db.ensureAccount(bob.accountId, bob.publicKeyB64);

  const cafe = { kind: 'group', id: 'GR-ABCDE-FGHJK' };
  const news = { kind: 'channel', id: 'CH-ABCDE-FGHJK' };

  // ПРОВЕРКА НЕ ПУСТАЯ: реестр вообще принимает заявку с предметом.
  assert.deepEqual(
    db.claimUsername(alice.accountId, 0, 'aircafe', null, null, cafe),
    { ok: true, username: 'aircafe' },
  );
  assert.deepEqual(
    { ...db.lookupUsername('aircafe') },
    {
      accountId: alice.accountId, profileId: 0, profilePublicKeyB64: null,
      displayName: null, subjectKind: 'group', subjectId: cafe.id,
    },
  );

  // Чужому аккаунту то же имя не достаётся — ни человеку, ни каналу.
  assert.deepEqual(
    db.claimUsername(bob.accountId, 0, 'aircafe'),
    { ok: false, reason: 'username_taken' },
  );
  assert.deepEqual(
    db.claimUsername(bob.accountId, 0, 'aircafe', null, null, news),
    { ok: false, reason: 'username_taken' },
  );

  // ПОВОД ДЛЯ ПРАВКИ ЖИВ: слот адреса отдельный от слота личного имени.
  // Тот же профиль занимает своё имя — адрес группы при этом остаётся.
  assert.deepEqual(
    db.claimUsername(alice.accountId, 0, 'margarita'),
    { ok: true, username: 'margarita' },
  );
  assert.equal(db.lookupUsername('aircafe').subjectId, cafe.id);
  assert.equal(db.lookupUsername('margarita').subjectKind, null);

  // И наоборот: переименование группы не трогает имя человека.
  assert.deepEqual(
    db.claimUsername(alice.accountId, 0, 'aircafe2', null, null, cafe),
    { ok: true, username: 'aircafe2' },
  );
  assert.equal(db.lookupUsername('aircafe'), null, 'прежний адрес группы освобождён');
  assert.equal(db.lookupUsername('margarita').accountId, alice.accountId, 'имя человека на месте');

  // Два разных предмета одного профиля живут порознь.
  assert.deepEqual(
    db.claimUsername(alice.accountId, 0, 'airnews', null, null, news),
    { ok: true, username: 'airnews' },
  );
  assert.equal(db.lookupUsername('aircafe2').subjectId, cafe.id);
  assert.equal(db.lookupUsername('airnews').subjectId, news.id);

  // Освобождение адресное: снятие адреса канала не снимает ни адрес группы,
  // ни личное имя. Без этого удаление группы стирало бы юзернейм владельца.
  db.releaseUsername(alice.accountId, 0, news.id);
  assert.equal(db.lookupUsername('airnews'), null);
  assert.equal(db.lookupUsername('aircafe2').subjectId, cafe.id);
  assert.equal(db.lookupUsername('margarita').accountId, alice.accountId);

  // Освобождение без предмета снимает ровно личное имя.
  db.releaseUsername(alice.accountId, 0);
  assert.equal(db.lookupUsername('margarita'), null);
  assert.equal(db.lookupUsername('aircafe2').subjectId, cafe.id);

  // Освобождённое имя достаётся другому — и человеку тоже.
  assert.deepEqual(
    db.claimUsername(bob.accountId, 0, 'margarita'),
    { ok: true, username: 'margarita' },
  );
});

/**
 * Предмет заявки приходит по сети, и доверять ему на слово нельзя: он уезжает
 * в ответ справочника, по которому открывается экран. Форма проверяется на
 * входе, а вид и приставка обязаны совпасть — «канал» с идентификатором
 * группы значит, что заявку собрали не нашим клиентом.
 */
test('предмет заявки принимается только в известном виде', () => {
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(src, /const SUBJECT_ID_RE = \/\^\(GR\|CH\)-\[0-9A-Z\]\{5\}-\[0-9A-Z\]\{5\}\$\//);
  assert.ok(src.includes('function readClaimSubject('), 'разбор предмета на месте');
  // Строка привязки дописывается ТОЛЬКО при наличии предмета: иначе подписи
  // прежних версий перестали бы сходиться побайтово.
  assert.ok(
    src.includes('subject ? `${base}:${subject.kind}:${subject.id}` : base'),
    'привязка расширяется условно',
  );
});
