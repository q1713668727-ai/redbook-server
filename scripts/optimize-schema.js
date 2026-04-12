const query = require('../util/dbHelper');

const DB_NAME = process.env.DB_NAME || 'server';

async function tableExists(table) {
  const rows = await query(
    'SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1;',
    [DB_NAME, table]
  );
  return rows.length > 0;
}

async function columnExists(table, column) {
  const rows = await query(
    'SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1;',
    [DB_NAME, table, column]
  );
  return rows.length > 0;
}

async function indexExists(table, indexName) {
  const rows = await query(
    'SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1;',
    [DB_NAME, table, indexName]
  );
  return rows.length > 0;
}

async function ensureColumn(table, column, ddl) {
  if (!(await tableExists(table))) {
    console.log(`[skip] table not found: ${table}`);
    return;
  }
  if (await columnExists(table, column)) {
    console.log(`[ok] column exists: ${table}.${column}`);
    return;
  }
  await query(`ALTER TABLE \`${table}\` ${ddl};`);
  console.log(`[add] column: ${table}.${column}`);
}

async function ensureIndex(table, indexName, columnsSql) {
  if (!(await tableExists(table))) {
    console.log(`[skip] table not found: ${table}`);
    return;
  }
  if (await indexExists(table, indexName)) {
    console.log(`[ok] index exists: ${table}.${indexName}`);
    return;
  }
  await query(`ALTER TABLE \`${table}\` ADD INDEX \`${indexName}\` (${columnsSql});`);
  console.log(`[add] index: ${table}.${indexName}`);
}

async function ensureCollectsCompatibility(table) {
  if (!(await tableExists(table))) {
    console.log(`[skip] table not found: ${table}`);
    return;
  }
  const hasCollects = await columnExists(table, 'collects');
  const hasCollect = await columnExists(table, 'collect');
  if (!hasCollects) {
    await query(`ALTER TABLE \`${table}\` ADD COLUMN \`collects\` INT NOT NULL DEFAULT 0;`);
    console.log(`[add] column: ${table}.collects`);
  } else {
    console.log(`[ok] column exists: ${table}.collects`);
  }
  if (hasCollect) {
    await query(`UPDATE \`${table}\` SET \`collects\` = IFNULL(\`collects\`, IFNULL(\`collect\`, 0));`);
    console.log(`[sync] ${table}.collect -> ${table}.collects`);
  }
}

async function run() {
  console.log(`[start] optimize schema on database: ${DB_NAME}`);

  await ensureCollectsCompatibility('note');
  await ensureCollectsCompatibility('video');

  await ensureColumn('login', 'likes', 'ADD COLUMN `likes` TEXT NULL');
  await ensureColumn('login', 'collects', 'ADD COLUMN `collects` TEXT NULL');
  await ensureColumn('login', 'auth_token', 'ADD COLUMN `auth_token` VARCHAR(128) NULL');
  await ensureColumn('login', 'auth_token_expire_at', 'ADD COLUMN `auth_token_expire_at` BIGINT NULL');
  await ensureColumn('login', 'following_accounts', 'ADD COLUMN `following_accounts` TEXT NULL');
  await ensureColumn('login', 'follower_accounts', 'ADD COLUMN `follower_accounts` TEXT NULL');

  await ensureIndex('login', 'idx_login_account', '`account`');
  await ensureIndex('login', 'idx_login_email', '`email`');
  await ensureIndex('login', 'idx_login_auth_token', '`auth_token`');

  await ensureIndex('msg', 'idx_msg_user_to_user', '`UserToUser`');
  await ensureIndex('msg', 'idx_msg_account', '`account`');

  await ensureIndex('note', 'idx_note_account', '`account`');
  await ensureIndex('note', 'idx_note_date', '`date`');
  await ensureIndex('note', 'idx_note_account_date', '`account`, `date`');

  await ensureIndex('video', 'idx_video_account', '`account`');
  await ensureIndex('video', 'idx_video_date', '`date`');
  await ensureIndex('video', 'idx_video_account_date', '`account`, `date`');

  console.log('[done] schema optimization complete');
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[error] schema optimization failed:', err);
    process.exit(1);
  });

