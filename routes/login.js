const express = require('express');
const query = require('../util/dbHelper.js');
const fs = require('fs');
const fsp = fs.promises;
const { issueToken, extractToken, verifyToken, clearToken, ensureTokenColumns } = require('../util/authToken');

const router = express.Router();
const avatarChunks = new Map();

ensureTokenColumns().catch((err) => {
  console.error('[login] init token columns failed:', err);
});

const catchError = (res, msg = 'Server error') => (err) => {
  console.error(`[login] ${msg}:`, err);
  res.send({ status: 500, message: msg, error: err.toString() });
};

const getSafeAccountPath = (account) => String(account || '').replace(/[^a-zA-Z0-9_-]/g, '');

router.post('/', async (req, res) => {
  try {
    const requestToken = extractToken(req);
    if (requestToken) {
      const tokenCheck = await verifyToken(requestToken);
      if (tokenCheck.ok) {
        const account = tokenCheck.account;
        const users = await query('SELECT * FROM `login` WHERE `account` = ? LIMIT 1;', [account]);
        if (users.length === 0) {
          return res.send({ status: 404, message: 'Account not found.' });
        }

        const userByToken = { ...users[0] };
        userByToken.password = undefined;
        if (userByToken.avatar) {
          userByToken.url = userByToken.avatar;
          userByToken.avatar = undefined;
        }

        return res.send({
          status: 200,
          message: 'Login success.',
          result: userByToken,
          token: requestToken,
          tokenExpireAt: tokenCheck.expireAt,
        });
      }
    }

    const { account, password } = req.body;
    const results = await query('SELECT * FROM `login` WHERE `account` = ? LIMIT 1;', [account]);

    if (results.length === 0) {
      return res.send({ status: 404, message: 'Account not found or password is incorrect.' });
    }

    const user = { ...results[0] };
    const isMatch = password === user.password;

    if (!isMatch) {
      return res.send({ status: 401, message: 'Password is incorrect.' });
    }

    const tokenData = await issueToken(user.account);
    user.password = undefined;
    if (user.avatar) {
      user.url = user.avatar;
      user.avatar = undefined;
    }

    return res.send({
      status: 200,
      message: 'Login success.',
      result: user,
      token: tokenData.token,
      tokenExpireAt: tokenData.expireAt,
    });
  } catch (err) {
    catchError(res, 'Login failed')(err);
  }
});

router.post('/logout', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.send({ status: 200, message: 'Logged out.' });
    }
    const check = await verifyToken(token);
    if (check.ok) {
      await clearToken(check.account);
    }
    return res.send({ status: 200, message: 'Logged out.' });
  } catch (err) {
    catchError(res, 'Logout failed')(err);
  }
});

router.post('/reg', async (req, res) => {
  try {
    const { name, account, password, email, path } = req.body;

    const result = await query(
      'INSERT INTO `login`(`avatar`,`name`,`account`,`password`,`email`) VALUES(?,?,?,?,?)',
      [path, name, account, password, email]
    );

    if (result.affectedRows === 1) {
      res.send({ status: 200, message: 'Register success.' });
    } else {
      res.send({ status: 404, message: 'Register failed.' });
    }
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.send({ status: 409, message: 'Account or email already exists.' });
    }
    catchError(res, 'Register failed')(err);
  }
});

router.post('/regAvatar', (req, res) => {
  const { account, data } = req.body;

  if (!account || !data || data.hash === undefined) {
    return res.send({ status: 400, message: 'Missing avatar chunk data.' });
  }

  if (!avatarChunks.has(account)) avatarChunks.set(account, []);
  avatarChunks.get(account)[data.hash] = req.body;
  res.send({ status: 200, message: 'Avatar chunk uploaded.' });
});

router.post('/regAvatarEnd', async (req, res) => {
  try {
    const { account, type } = req.body;
    const safeAccount = getSafeAccountPath(account);

    if (!safeAccount) {
      return res.send({ status: 400, message: 'Invalid account.' });
    }

    const users = await query('SELECT account FROM `login` WHERE `account` = ? LIMIT 1;', [account]);
    if (users.length >= 1 && !type) {
      return res.send({ status: 409, message: 'Account already exists.' });
    }

    const userChunks = avatarChunks.get(account) || [];
    if (userChunks.length === 0) {
      return res.send({ status: 400, message: 'No avatar chunks received.' });
    }

    let file = '';
    for (let i = 0; i < userChunks.length; i++) {
      if (!userChunks[i]) {
        avatarChunks.delete(account);
        return res.send({ status: 400, message: `Avatar chunk ${i} is missing.` });
      }
      file += userChunks[i].data.chunk;
    }

    avatarChunks.delete(account);

    const dirPath = `public/user-avatar/${safeAccount}`;
    const randomSuffix = Math.floor(Math.random() * 1000);
    const filePath = `user-avatar/${safeAccount}/${Date.now()}_${randomSuffix}.jpg`;
    const base64 = file.replace(/^data:image\/\w+;base64,/, '');
    const dataBuffer = Buffer.from(base64, 'base64');

    await fsp.mkdir(dirPath, { recursive: true });
    await fsp.writeFile(`public/${filePath}`, dataBuffer);

    if (type === 'set') {
      const updateRes = await query('UPDATE `login` SET avatar = ? WHERE `account` = ?;', [filePath, account]);
      if (updateRes.affectedRows === 1) {
        return res.send({ status: 200, message: 'Avatar updated.', result: { path: filePath } });
      }
      return res.send({ status: 400, message: 'Avatar update failed.' });
    }

    res.send({ status: 200, message: 'Avatar saved.', result: { path: filePath } });
  } catch (err) {
    catchError(res, 'Avatar processing failed')(err);
  }
});

module.exports = router;
