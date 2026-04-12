const crypto = require('crypto');
const query = require('./dbHelper');

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let ensureColumnsTask = null;

async function ensureTokenColumns() {
  if (ensureColumnsTask) {
    return ensureColumnsTask;
  }

  ensureColumnsTask = (async () => {
    const columns = await query('SHOW COLUMNS FROM `login`;');
    const columnSet = new Set(columns.map((item) => item.Field));
    const alterParts = [];

    if (!columnSet.has('auth_token')) {
      alterParts.push('ADD COLUMN `auth_token` VARCHAR(128) NULL');
    }
    if (!columnSet.has('auth_token_expire_at')) {
      alterParts.push('ADD COLUMN `auth_token_expire_at` BIGINT NULL');
    }

    if (alterParts.length > 0) {
      await query(`ALTER TABLE \`login\` ${alterParts.join(', ')};`);
    }
  })().catch((err) => {
    ensureColumnsTask = null;
    throw err;
  });

  return ensureColumnsTask;
}

function buildToken(account) {
  const accountPart = encodeURIComponent(String(account || '').trim());
  const randomPart = crypto.randomBytes(32).toString('hex');
  return `${accountPart}.${randomPart}`;
}

function parseAccountFromToken(token) {
  if (!token || typeof token !== 'string') {
    return '';
  }

  const idx = token.indexOf('.');
  if (idx <= 0) {
    return '';
  }

  const encoded = token.slice(0, idx);
  try {
    return decodeURIComponent(encoded);
  } catch (err) {
    return '';
  }
}

async function issueToken(account) {
  const cleanAccount = String(account || '').trim();
  if (!cleanAccount) {
    throw new Error('Invalid account.');
  }

  await ensureTokenColumns();

  const token = buildToken(cleanAccount);
  const expireAt = Date.now() + TOKEN_TTL_MS;

  await query(
    'UPDATE `login` SET `auth_token` = ?, `auth_token_expire_at` = ? WHERE `account` = ? LIMIT 1;',
    [token, expireAt, cleanAccount]
  );

  return { token, expireAt };
}

function extractToken(req) {
  const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (typeof authHeader === 'string' && authHeader.trim()) {
    const text = authHeader.trim();
    if (/^Bearer\s+/i.test(text)) {
      return text.replace(/^Bearer\s+/i, '').trim();
    }
    return text;
  }

  if (req.body && typeof req.body.token === 'string' && req.body.token.trim()) {
    return req.body.token.trim();
  }

  if (req.query && typeof req.query.token === 'string' && req.query.token.trim()) {
    return req.query.token.trim();
  }

  return '';
}

async function verifyToken(token) {
  await ensureTokenColumns();

  const account = parseAccountFromToken(token);
  if (!account) {
    return { ok: false, code: 'TOKEN_INVALID', message: '无效登录令牌，请重新登录。' };
  }

  const users = await query(
    'SELECT `account`, `auth_token`, `auth_token_expire_at` FROM `login` WHERE `account` = ? LIMIT 1;',
    [account]
  );
  if (users.length === 0) {
    return { ok: false, code: 'TOKEN_INVALID', message: '账号不存在，请重新登录。' };
  }

  const user = users[0];
  if (!user.auth_token) {
    return { ok: false, code: 'TOKEN_INVALID', message: '登录状态已失效，请重新登录。' };
  }

  if (String(user.auth_token) !== String(token)) {
    return { ok: false, code: 'TOKEN_KICKED_OUT', message: '账号已在其他设备登录，当前设备已下线。' };
  }

  const expireAt = Number(user.auth_token_expire_at || 0);
  if (!expireAt || expireAt <= Date.now()) {
    await clearToken(account);
    return { ok: false, code: 'TOKEN_EXPIRED', message: '登录已过期，请重新登录。' };
  }

  return { ok: true, account, expireAt };
}

async function clearToken(account) {
  const cleanAccount = String(account || '').trim();
  if (!cleanAccount) {
    return;
  }
  await ensureTokenColumns();
  await query(
    'UPDATE `login` SET `auth_token` = NULL, `auth_token_expire_at` = NULL WHERE `account` = ? LIMIT 1;',
    [cleanAccount]
  );
}

module.exports = {
  TOKEN_TTL_MS,
  ensureTokenColumns,
  issueToken,
  extractToken,
  verifyToken,
  clearToken,
};
