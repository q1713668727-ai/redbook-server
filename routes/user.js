const express = require('express');
const query = require('../util/dbHelper.js');
const fs = require('fs');
const fsp = fs.promises;

const router = express.Router();
const bgChunks = new Map();
let ensureFollowColumnsTask = null;
const collectColumnCache = new Map();

const catchError = (res, msg = 'Server error') => (err) => {
  console.error(`[user] ${msg}:`, err);
  res.send({ status: 500, message: msg, error: err.toString() });
};

const mergeChunks = (account, chunkMap) => {
  const userChunks = chunkMap.get(account) || [];
  let fileBase64 = '';

  for (let i = 0; i < userChunks.length; i++) {
    if (!userChunks[i]) throw new Error('File chunk is incomplete.');
    fileBase64 += userChunks[i].data.chunk;
  }

  chunkMap.delete(account);
  const base64Data = fileBase64.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(base64Data, 'base64');
};

const getSafeAccountPath = (account) => String(account || '').replace(/[^a-zA-Z0-9_-]/g, '');

const parseAccountList = (text) => {
  if (!text) return [];
  return String(text)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const listToText = (list) => Array.from(new Set((list || []).map((item) => String(item).trim()).filter(Boolean))).join(',');

const parseContentRefs = (text, defaultType = 'note') => {
  if (!text) return [];
  const tokens = String(text).split(',').map((item) => String(item || '').trim()).filter(Boolean);
  const seen = new Set();
  const refs = [];
  tokens.forEach((token) => {
    let contentType = defaultType;
    let rawId = token;
    if (token.startsWith('note-')) {
      contentType = 'note';
      rawId = token.slice(5);
    } else if (token.startsWith('video-')) {
      contentType = 'video';
      rawId = token.slice(6);
    }
    const id = Number(rawId);
    if (!Number.isFinite(id)) return;
    const key = `${contentType}-${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ contentType, id, key });
  });
  return refs;
};

const normalizeNoteItem = (item) => ({
  ...item,
  contentType: 'note',
  feedKey: `note-${item.id}`,
  collects: item.collects != null ? item.collects : (item.collect != null ? item.collect : 0),
});

const normalizeVideoItem = (item) => ({
  ...item,
  contentType: 'video',
  feedKey: `video-${item.id}`,
  cover: item.image || '',
  url: item.image || '',
  videoUrl: item.url || '',
  brief: '',
  collects: item.collects != null ? item.collects : (item.collect != null ? item.collect : 0),
  location: item.location || '',
});

const resolveCollectColumn = async (table) => {
  if (collectColumnCache.has(table)) {
    return collectColumnCache.get(table);
  }
  const columns = await query(`SHOW COLUMNS FROM \`${table}\`;`);
  const names = new Set(columns.map((item) => item.Field));
  const column = names.has('collects') ? 'collects' : (names.has('collect') ? 'collect' : null);
  collectColumnCache.set(table, column);
  return column;
};

const loadContentByRefs = async (refs = []) => {
  if (!Array.isArray(refs) || refs.length === 0) {
    return [];
  }
  const noteIds = refs.filter((item) => item.contentType === 'note').map((item) => item.id);
  const videoIds = refs.filter((item) => item.contentType === 'video').map((item) => item.id);
  const [noteRows, videoRows] = await Promise.all([
    noteIds.length ? query(`SELECT * FROM \`note\` WHERE \`id\` IN (${noteIds.map(() => '?').join(',')});`, noteIds) : Promise.resolve([]),
    videoIds.length ? query(`SELECT * FROM \`video\` WHERE \`id\` IN (${videoIds.map(() => '?').join(',')});`, videoIds) : Promise.resolve([]),
  ]);
  const noteMap = new Map(noteRows.map((item) => [item.id, normalizeNoteItem(item)]));
  const videoMap = new Map(videoRows.map((item) => [item.id, normalizeVideoItem(item)]));
  return refs
    .map((ref) => (ref.contentType === 'video' ? videoMap.get(ref.id) : noteMap.get(ref.id)))
    .filter(Boolean);
};

const loadUserRefsByField = async (account, field, defaultType = 'note') => {
  const sql = `SELECT \`${field}\` FROM \`login\` WHERE \`account\` = ? LIMIT 1;`;
  const results = await query(sql, [account]);
  const rawText = results.length ? results[0][field] : '';
  if (!results.length || !rawText) {
    return [];
  }
  return parseContentRefs(rawText, defaultType);
};

const relationOf = (myFollowingSet, myFollowerSet, targetAccount) => {
  const followed = myFollowingSet.has(targetAccount);
  const fan = myFollowerSet.has(targetAccount);
  return {
    followed,
    fan,
    mutual: followed && fan,
  };
};

const ensureFollowColumns = async () => {
  if (ensureFollowColumnsTask) return ensureFollowColumnsTask;
  ensureFollowColumnsTask = (async () => {
    const columns = await query('SHOW COLUMNS FROM `login`;');
    const names = new Set(columns.map((item) => item.Field));
    const alters = [];
    if (!names.has('following_accounts')) alters.push('ADD COLUMN `following_accounts` TEXT NULL');
    if (!names.has('follower_accounts')) alters.push('ADD COLUMN `follower_accounts` TEXT NULL');
    if (alters.length) {
      await query(`ALTER TABLE \`login\` ${alters.join(', ')};`);
    }
  })().catch((err) => {
    ensureFollowColumnsTask = null;
    throw err;
  });
  return ensureFollowColumnsTask;
};

const getCurrentAccount = (req) => String((req.auth && req.auth.account) || req.body.account || '').trim();

const pickPublicUser = (user) => ({
  account: user.account,
  name: user.name || user.account,
  avatar: user.avatar || '',
  url: user.avatar || '',
  attention: Number(user.attention || 0),
  fans: Number(user.fans || 0),
});

const syncUserFollowCount = async (account, followingList, followerList) => {
  await query(
    'UPDATE `login` SET `following_accounts` = ?, `follower_accounts` = ?, `attention` = ?, `fans` = ? WHERE `account` = ? LIMIT 1;',
    [listToText(followingList), listToText(followerList), followingList.length, followerList.length, account]
  );
};

router.post('/getUserInfo', async (req, res) => {
  try {
    await ensureFollowColumns();
    const { account } = req.body;
    if (!account) {
      return res.send({ status: 400, message: 'Account is required.' });
    }
    const results = await query('SELECT * FROM `login` WHERE `account` = ? LIMIT 1;', [account]);
    if (!results.length) {
      return res.send({ status: 404, message: 'User not found.' });
    }
    const user = { ...results[0] };
    const followingList = parseAccountList(user.following_accounts);
    const followerList = parseAccountList(user.follower_accounts);
    user.attention = followingList.length;
    user.fans = followerList.length;
    user.password = undefined;
    if (user.avatar) {
      user.url = user.avatar;
      user.avatar = undefined;
    }
    res.send({ status: 200, message: 'Fetch success.', result: user });
  } catch (err) {
    catchError(res, 'Fetch user info failed')(err);
  }
});

router.post('/followStatus', async (req, res) => {
  try {
    await ensureFollowColumns();
    const myAccount = getCurrentAccount(req);
    const targetAccount = String(req.body.targetAccount || '').trim();
    if (!myAccount || !targetAccount) {
      return res.send({ status: 400, message: 'Missing account.' });
    }
    if (myAccount === targetAccount) {
      return res.send({ status: 200, message: 'Self relation.', result: { followed: false, fan: false, mutual: false } });
    }

    const rows = await query(
      'SELECT `account`,`following_accounts`,`follower_accounts` FROM `login` WHERE `account` IN (?, ?);',
      [myAccount, targetAccount]
    );
    const myRow = rows.find((item) => item.account === myAccount);
    if (!myRow) return res.send({ status: 404, message: 'User not found.' });
    const myFollowingSet = new Set(parseAccountList(myRow.following_accounts));
    const myFollowerSet = new Set(parseAccountList(myRow.follower_accounts));
    const relation = relationOf(myFollowingSet, myFollowerSet, targetAccount);
    return res.send({ status: 200, message: 'Fetch success.', result: relation });
  } catch (err) {
    catchError(res, 'Fetch follow status failed')(err);
  }
});

router.post('/toggleFollow', async (req, res) => {
  try {
    await ensureFollowColumns();
    const myAccount = getCurrentAccount(req);
    const targetAccount = String(req.body.targetAccount || '').trim();
    const action = String(req.body.action || '').trim();

    if (!myAccount || !targetAccount) {
      return res.send({ status: 400, message: 'Missing account.' });
    }
    if (myAccount === targetAccount) {
      return res.send({ status: 400, message: 'Cannot follow self.' });
    }

    const rows = await query(
      'SELECT `account`,`name`,`avatar`,`attention`,`fans`,`following_accounts`,`follower_accounts` FROM `login` WHERE `account` IN (?, ?);',
      [myAccount, targetAccount]
    );
    const myRow = rows.find((item) => item.account === myAccount);
    const targetRow = rows.find((item) => item.account === targetAccount);
    if (!myRow || !targetRow) {
      return res.send({ status: 404, message: 'User not found.' });
    }

    const myFollowing = new Set(parseAccountList(myRow.following_accounts));
    const myFollowers = new Set(parseAccountList(myRow.follower_accounts));
    const targetFollowing = new Set(parseAccountList(targetRow.following_accounts));
    const targetFollowers = new Set(parseAccountList(targetRow.follower_accounts));

    const shouldFollow = action
      ? action === 'follow'
      : !myFollowing.has(targetAccount);

    if (shouldFollow) {
      myFollowing.add(targetAccount);
      targetFollowers.add(myAccount);
    } else {
      myFollowing.delete(targetAccount);
      targetFollowers.delete(myAccount);
    }

    await syncUserFollowCount(myAccount, Array.from(myFollowing), Array.from(myFollowers));
    await syncUserFollowCount(targetAccount, Array.from(targetFollowing), Array.from(targetFollowers));

    const relation = relationOf(myFollowing, myFollowers, targetAccount);
    return res.send({
      status: 200,
      message: shouldFollow ? 'Followed.' : 'Unfollowed.',
      result: {
        ...relation,
        self: {
          account: myAccount,
          attention: myFollowing.size,
          fans: myFollowers.size,
        },
        target: {
          account: targetAccount,
          attention: targetFollowing.size,
          fans: targetFollowers.size,
        },
      },
    });
  } catch (err) {
    catchError(res, 'Toggle follow failed')(err);
  }
});

router.post('/followList', async (req, res) => {
  try {
    await ensureFollowColumns();
    const myAccount = getCurrentAccount(req);
    const type = String(req.body.type || 'follow').trim();
    if (!myAccount) return res.send({ status: 400, message: 'Missing account.' });

    const rows = await query(
      'SELECT `account`,`name`,`avatar`,`attention`,`fans`,`following_accounts`,`follower_accounts` FROM `login`;'
    );
    const myRow = rows.find((item) => item.account === myAccount);
    if (!myRow) return res.send({ status: 404, message: 'User not found.' });

    const myFollowing = new Set(parseAccountList(myRow.following_accounts));
    const myFollowers = new Set(parseAccountList(myRow.follower_accounts));
    const mutual = new Set([...myFollowing].filter((item) => myFollowers.has(item)));

    const allByAccount = new Map(rows.map((item) => [item.account, item]));
    const pickWithRelation = (account) => {
      const row = allByAccount.get(account);
      if (!row) return null;
      const publicUser = pickPublicUser(row);
      const relation = relationOf(myFollowing, myFollowers, account);
      return { ...publicUser, ...relation };
    };

    let accountList = [];
    if (type === 'fans') {
      accountList = Array.from(myFollowers);
    } else if (type === 'mutual') {
      accountList = Array.from(mutual);
    } else if (type === 'recommend') {
      accountList = rows
        .map((item) => item.account)
        .filter((account) => account !== myAccount && !myFollowing.has(account))
        .slice(0, 200);
    } else {
      accountList = Array.from(myFollowing);
    }

    const data = accountList.map((account) => pickWithRelation(account)).filter(Boolean);
    return res.send({
      status: 200,
      message: 'Fetch success.',
      result: {
        type,
        data,
        summary: {
          follow: myFollowing.size,
          fans: myFollowers.size,
          mutual: mutual.size,
        },
      },
    });
  } catch (err) {
    catchError(res, 'Fetch follow list failed')(err);
  }
});
router.post('/addLikeNote', async (req, res) => {
  try {
    const { likesArr, account, num, setId } = req.body;
    const contentType = String(req.body.contentType || 'note').trim() === 'video' ? 'video' : 'note';
    const table = contentType === 'video' ? 'video' : 'note';

    const loginRes = await query('UPDATE `login` SET likes = ? WHERE `account` = ?;', [likesArr, account]);
    if (loginRes.affectedRows === 0) return res.send({ status: 404, message: 'User not found.' });

    const targetRes = await query(`UPDATE \`${table}\` SET likes = ? WHERE \`id\` = ?;`, [num, setId]);
    if (targetRes.affectedRows === 0) return res.send({ status: 404, message: `${contentType} not found.` });

    res.send({ status: 200, message: 'Like updated.' });
  } catch (err) {
    catchError(res, 'Like update failed')(err);
  }
});

router.post('/addCollectNote', async (req, res) => {
  try {
    const { collectsArr, account, num, setId } = req.body;
    const contentType = String(req.body.contentType || 'note').trim() === 'video' ? 'video' : 'note';
    const table = contentType === 'video' ? 'video' : 'note';

    const loginRes = await query('UPDATE `login` SET collects = ? WHERE `account` = ?;', [collectsArr, account]);
    if (loginRes.affectedRows === 0) return res.send({ status: 404, message: 'User not found.' });

    const collectColumn = await resolveCollectColumn(table);
    if (collectColumn) {
      const targetRes = await query(`UPDATE \`${table}\` SET \`${collectColumn}\` = ? WHERE \`id\` = ?;`, [num, setId]);
      if (targetRes.affectedRows === 0) return res.send({ status: 404, message: `${contentType} not found.` });
    }

    res.send({ status: 200, message: 'Collect updated.' });
  } catch (err) {
    catchError(res, 'Collect update failed')(err);
  }
});

router.post('/myNote', async (req, res) => {
  try {
    const [noteRows, videoRows] = await Promise.all([
      query('SELECT * FROM `note` WHERE `account` = ?;', [req.body.account]),
      query('SELECT * FROM `video` WHERE `account` = ?;', [req.body.account]),
    ]);
    const list = [
      ...noteRows.map(normalizeNoteItem),
      ...videoRows.map(normalizeVideoItem),
    ].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
    res.send({ status: 200, message: 'Fetch success.', result: { data: list } });
  } catch (err) {
    catchError(res, 'Query failed')(err);
  }
});

router.post('/findLikeNote', async (req, res) => {
  try {
    const refs = await loadUserRefsByField(req.body.account, 'likes', 'note');
    if (refs.length === 0) {
      return res.send({ status: 200, message: 'Fetch success.', result: { data: [] } });
    }
    const data = await loadContentByRefs(refs);

    res.send({ status: 200, message: 'Fetch success.', result: { data } });
  } catch (err) {
    catchError(res, 'Favorite query failed')(err);
  }
});

router.post('/findCollectNote', async (req, res) => {
  try {
    const refs = await loadUserRefsByField(req.body.account, 'collects', 'note');
    if (refs.length === 0) {
      return res.send({ status: 200, message: 'Fetch success.', result: { data: [] } });
    }
    const data = await loadContentByRefs(refs);

    res.send({ status: 200, message: 'Fetch success.', result: { data } });
  } catch (err) {
    catchError(res, 'Collect query failed')(err);
  }
});

router.post('/setBackground', (req, res) => {
  const { account, data } = req.body;
  if (!account || !data || data.hash === undefined) {
    return res.send({ status: 400, message: 'Missing params.' });
  }

  if (!bgChunks.has(account)) bgChunks.set(account, []);
  bgChunks.get(account)[data.hash] = req.body;
  res.send({ status: 200, message: 'Background chunk uploaded.' });
});

router.post('/setBackgroundEnd', async (req, res) => {
  try {
    const { account } = req.body;
    const safeAccount = getSafeAccountPath(account);

    if (!safeAccount) {
      return res.send({ status: 400, message: 'Invalid account.' });
    }

    let dataBuffer;
    try {
      dataBuffer = mergeChunks(account, bgChunks);
    } catch (e) {
      return res.send({ status: 400, message: e.message });
    }

    const fileName = `${Date.now()}.jpg`;
    const relativePath = `user-background/${safeAccount}/${fileName}`;
    const fullDirPath = `public/user-background/${safeAccount}`;

    await fsp.mkdir(fullDirPath, { recursive: true });
    await fsp.writeFile(`public/${relativePath}`, dataBuffer);

    const updateRes = await query('UPDATE `login` SET background = ? WHERE `account` = ?;', [relativePath, account]);

    if (updateRes.affectedRows === 1) {
      res.send({ status: 200, message: 'Background updated.', result: { path: relativePath } });
    } else {
      res.send({ status: 404, message: 'Database update failed.' });
    }
  } catch (err) {
    catchError(res, 'Background update failed')(err);
  }
});

module.exports = router;



