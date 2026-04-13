const express = require('express');
const query = require('../util/dbHelper.js');
const router = express.Router();

const avatarChunks = new Map();
const bgChunks = new Map();

const catchError = (res, msg = 'Server error') => (err) => {
  console.error(`[index] ${msg}:`, err);
  res.send({ status: 500, message: msg, error: err.toString() });
};


const parseNoteComments = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  const text = String(raw).trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    const items = text.split(';/').filter(Boolean);
    return items.map((item) => {
      try {
        return JSON.parse(item);
      } catch (err) {
        return null;
      }
    }).filter(Boolean);
  }
};

const toSafeNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const normalizeLikeUsers = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return text.split(',').map((item) => item.trim()).filter(Boolean).map((account) => ({ account }));
    }
  }
  return [];
};

const shuffleList = (list = []) => {
  const arr = Array.isArray(list) ? [...list] : [];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

router.post('/index', async (req, res) => {
  try {
    let num = req.body.init ? 20 : 10;
    const idTokens = String(req.body.idList || '').split(',').map((item) => String(item).trim()).filter(Boolean);
    const excludedNoteIds = [];
    const excludedVideoIds = [];

    idTokens.forEach((token) => {
      if (token.startsWith('note-')) {
        const id = Number(token.slice(5));
        if (Number.isFinite(id)) excludedNoteIds.push(id);
        return;
      }
      if (token.startsWith('video-')) {
        const id = Number(token.slice(6));
        if (Number.isFinite(id)) excludedVideoIds.push(id);
        return;
      }
      const legacyId = Number(token);
      if (Number.isFinite(legacyId)) {
        excludedNoteIds.push(legacyId);
      }
    });

    const typeLimit = Math.max(num * 2, 20);
    let noteSql = 'SELECT * FROM `note` ORDER BY RAND() LIMIT ?;';
    let noteParams = [typeLimit];
    let videoSql = 'SELECT * FROM `video` ORDER BY RAND() LIMIT ?;';
    let videoParams = [typeLimit];

    if (excludedNoteIds.length > 0) {
      const placeholders = excludedNoteIds.map(() => '?').join(',');
      noteSql = `SELECT * FROM \`note\` WHERE \`id\` NOT IN (${placeholders}) ORDER BY RAND() LIMIT ?;`;
      noteParams = [...excludedNoteIds, typeLimit];
    }
    if (excludedVideoIds.length > 0) {
      const placeholders = excludedVideoIds.map(() => '?').join(',');
      videoSql = `SELECT * FROM \`video\` WHERE \`id\` NOT IN (${placeholders}) ORDER BY RAND() LIMIT ?;`;
      videoParams = [...excludedVideoIds, typeLimit];
    }

    const [noteRows, videoRows] = await Promise.all([
      query(noteSql, noteParams),
      query(videoSql, videoParams),
    ]);

    const noteList = noteRows.map((item) => ({
      ...item,
      contentType: 'note',
      feedKey: `note-${item.id}`,
    }));
    const videoList = videoRows.map((item) => ({
      ...item,
      contentType: 'video',
      feedKey: `video-${item.id}`,
      cover: item.image || '',
      url: item.image || '',
      videoUrl: item.url || '',
      brief: '',
      collects: item.collects != null ? item.collects : (item.collect != null ? item.collect : 0),
      location: item.location || '',
    }));

    const result = shuffleList([...noteList, ...videoList]).slice(0, num);
    res.send({ status: 200, message: 'Fetch success.', result });
  } catch (err) {
    catchError(res, 'Fetch failed')(err);
  }
});

router.post('/clearBadge', async (req, res) => {
  try {
    const target = `${req.body.account}-${req.body.targetUser}`;
    const result = await query('SELECT * FROM `msg` WHERE `UserToUser` = ?;', [target]);

    if (result.length === 0) {
      return res.send({ status: 404, message: 'Message record not found.' });
    }

    let messageObj = JSON.parse(result[0].message);
    messageObj.read = 0;

    const updateRes = await query('UPDATE `msg` SET message = ? WHERE `UserToUser` = ?;', [JSON.stringify(messageObj), target]);
    if (updateRes.affectedRows === 0) {
      return res.send({ status: 404, message: 'Update failed.' });
    }

    res.send({ status: 200, message: 'Badge cleared.' });
  } catch (err) {
    catchError(res, 'Clear badge failed')(err);
  }
});

router.post('/deleteUser', async (req, res) => {
  try {
    const t1 = `${req.body.account}-${req.body.targetUser}`;
    const t2 = `${req.body.targetUser}-${req.body.account}`;

    const res1 = await query('DELETE FROM `msg` WHERE `UserToUser` = ?;', [t1]);
    if (res1.affectedRows === 0) return res.send({ status: 404, message: 'Delete failed.' });

    const res2 = await query('DELETE FROM `msg` WHERE `UserToUser` = ?;', [t2]);
    if (res2.affectedRows === 0) return res.send({ status: 404, message: 'Delete failed.' });

    res.send({ status: 200, message: 'Delete success.' });
  } catch (err) {
    catchError(res, 'Delete failed')(err);
  }
});

router.post('/setUserData', async (req, res) => {
  try {
    const fieldMap = {
      name: 'name',
      email: 'email',
      sign: 'sign',
      about: 'about',
      avatar: 'avatar',
      background: 'background',
      birthday: 'birthday',
      sex: 'sex',
      occupation: 'occupation',
      school: 'school',
      district: 'district',
      password: 'password',
    };
    const field = fieldMap[String(req.body.type || '').trim()];

    if (!field) {
      return res.send({ status: 400, message: 'Invalid field.' });
    }

    const sql = `UPDATE \`login\` SET \`${field}\` = ? WHERE \`account\` = ?;`;
    const result = await query(sql, [req.body.data, req.body.account]);

    if (result.affectedRows === 1) res.send({ status: 200, message: 'Update success.' });
    else res.send({ status: 404, message: 'Update failed.' });
  } catch (err) {
    catchError(res, 'Update failed')(err);
  }
});

router.post('/getAllUser', async (req, res) => {
  try {
    const result = await query('SELECT * FROM `login`;');
    const excludeAccounts = Array.isArray(req.body.account) ? req.body.account : [];

    const arr = result
      .filter(item => !excludeAccounts.includes(item.account))
      .map(item => ({
        ...item,
        url: item.avatar,
        avatar: undefined,
        password: undefined,
      }));

    res.send({ status: 200, message: 'Fetch success.', result: arr });
  } catch (err) {
    catchError(res, 'Fetch users failed')(err);
  }
});


router.post('/getConversation', async (req, res) => {
  try {
    const account = String(req.body.account || '').trim();
    const target = String(req.body.target || '').trim();
    if (!account || !target) {
      return res.send({ status: 400, message: 'Missing account or target.' });
    }

    const meKey = `${account}-${target}`;
    const targetKey = `${target}-${account}`;
    const result = await query(
      'SELECT * FROM `msg` WHERE `UserToUser` IN (?, ?);',
      [meKey, targetKey]
    );

    let current = null;
    let reverse = null;
    result.forEach((item) => {
      if (item.UserToUser === meKey) {
        current = item;
      } else if (item.UserToUser === targetKey) {
        reverse = item;
      }
    });

    if (!current && !reverse) {
      return res.send({
        status: 200,
        message: 'First conversation.',
        firstChat: true,
        result: null,
      });
    }

    const raw = current || reverse;
    let message = {};
    try {
      message = JSON.parse(raw.message || '{}');
    } catch (error) {
      message = {};
    }

    const historyMessage = Array.isArray(message.historyMessage) ? message.historyMessage : [];
    const normalizedHistory = historyMessage.map((item) => {
      const nextItem = { ...item, text: item.text ? { ...item.text } : {} };
      if (nextItem.text.type === 'emoji' && nextItem.text.url && !String(nextItem.text.url).startsWith('images/emoji/')) {
        nextItem.text.url = 'images/emoji/' + nextItem.text.url;
      } else if (nextItem.text.type === 'file' && nextItem.text.url) {
        const suffix = String(nextItem.text.url).split('.');
        nextItem.text.suffix = suffix[suffix.length - 1];
      }
      return nextItem;
    });

    const normalized = {
      id: message.id || target,
      title: message.title || target,
      avatar: message.avatar || '',
      url: message.avatar || '',
      read: Number(message.read || 0),
      historyMessage: normalizedHistory,
    };

    res.send({
      status: 200,
      message: 'Conversation found.',
      firstChat: false,
      result: normalized,
      syncNeeded: !current || !reverse,
    });
  } catch (err) {
    catchError(res, 'Fetch conversation failed')(err);
  }
});

router.post('/add', async (req, res) => {
  try {
    const { me, you } = req.body;
    if (!me || !you || !me.UserToUser || !you.UserToUser || !me.account || !you.account) {
      return res.send({ status: 400, message: 'Invalid add friend payload.' });
    }

    const exists = await query(
      'SELECT `UserToUser` FROM `msg` WHERE `UserToUser` IN (?, ?);',
      [me.UserToUser, you.UserToUser]
    );

    const existingKeys = new Set(exists.map(item => item.UserToUser));
    const values = [];
    const params = [];

    if (!existingKeys.has(me.UserToUser)) {
      values.push('(?,?,?)');
      params.push(me.UserToUser, me.account, me.message);
    }

    if (!existingKeys.has(you.UserToUser)) {
      values.push('(?,?,?)');
      params.push(you.UserToUser, you.account, you.message);
    }

    // ???????????????????????????? 409?
    if (values.length === 0) {
      return res.send({ status: 200, message: 'Conversation ready.' });
    }

    const result = await query(
      `INSERT INTO \`msg\`(\`UserToUser\`,\`account\`,\`message\`) VALUES ${values.join(',')}`,
      params
    );

    if (result.affectedRows === values.length) {
      res.send({ status: 200, message: 'Conversation ready.' });
    } else {
      res.send({ status: 404, message: 'Conversation init failed.' });
    }
  } catch (err) {
    catchError(res, 'Add friend failed')(err);
  }
});

router.post('/upload/addComment', async (req, res) => {
  try {
    const noteId = req.body.id;
    const contentType = String(req.body.contentType || 'note').trim().toLowerCase();
    const table = contentType === 'video' ? 'video' : 'note';
    const contentLabel = table === 'video' ? 'Video' : 'Note';
    if (!noteId) {
      return res.send({ status: 400, message: `Missing ${contentLabel.toLowerCase()} id.` });
    }

    const result = await query(`SELECT \`comment\` FROM \`${table}\` WHERE \`id\` = ?;`, [noteId]);
    if (result.length === 0) return res.send({ status: 404, message: `${contentLabel} not found.` });

    const oldComments = parseNoteComments(result[0].comment).map((item) => {
      const likeUsers = normalizeLikeUsers(item.likeUsers || item.likeAccounts || item.likeUserInfo)
        .map((user) => ({
          account: String(user.account || '').trim(),
          name: user.name || '',
          avatar: user.avatar || '',
        }))
        .filter((user) => user.account);
      return {
        ...item,
        id: toSafeNumber(item.id, Date.now()),
        likeUsers,
        likeCount: toSafeNumber(item.likeCount || item.likes, likeUsers.length),
        replies: Array.isArray(item.replies) ? item.replies.map((reply) => ({
          ...reply,
          id: toSafeNumber(reply.id, Date.now()),
          likeCount: toSafeNumber(reply.likeCount || reply.likes, 0),
        })) : [],
      };
    });

    const action = String(req.body.action || 'add').trim();

    if (action === 'like') {
      const commentId = toSafeNumber(req.body.commentId);
      const parentId = toSafeNumber(req.body.parentId);
      const account = String(req.body.account || '').trim();
      const name = String(req.body.name || '').trim();
      const avatar = String(req.body.avatar || '').trim();
      if (!commentId || !account) {
        return res.send({ status: 400, message: 'Missing commentId or account.' });
      }
      if (parentId !== 0) {
        return res.send({ status: 400, message: 'Only top-level comments support likes.' });
      }

      const targetIndex = oldComments.findIndex((item) => toSafeNumber(item.id) === commentId);
      if (targetIndex === -1) {
        return res.send({ status: 404, message: 'Comment not found.' });
      }

      const current = oldComments[targetIndex];
      const likeUsers = Array.isArray(current.likeUsers) ? [...current.likeUsers] : [];
      const existsIndex = likeUsers.findIndex((user) => String(user.account || '') === account);
      let liked = false;
      if (existsIndex > -1) {
        likeUsers.splice(existsIndex, 1);
        liked = false;
      } else {
        likeUsers.push({ account, name, avatar });
        liked = true;
      }
      oldComments[targetIndex] = {
        ...current,
        likeUsers,
        likeCount: likeUsers.length,
      };

      const updateLikeRes = await query(`UPDATE \`${table}\` SET \`comment\` = ? WHERE \`id\` = ?;`, [JSON.stringify(oldComments), noteId]);
      if (updateLikeRes.affectedRows === 1) {
        return res.send({
          status: 200,
          message: 'Comment like updated.',
          result: {
            commentId,
            liked,
            likeCount: likeUsers.length,
            likeUsers,
          },
        });
      }
      return res.send({ status: 404, message: 'Comment like update failed.' });
    }

    if (action === 'reply') {
      const parentId = toSafeNumber(req.body.parentId);
      if (!parentId) {
        return res.send({ status: 400, message: 'Missing parentId.' });
      }

      const parentIdx = oldComments.findIndex((item) => toSafeNumber(item.id) === parentId);
      if (parentIdx === -1) {
        return res.send({ status: 404, message: 'Parent comment not found.' });
      }

      const parentComment = oldComments[parentIdx];
      const reply = {
        id: Date.now(),
        parentId,
        account: req.body.account || '',
        name: req.body.name || '用户',
        text: req.body.text || '',
        avatar: req.body.avatar || '',
        likeCount: toSafeNumber(req.body.likeCount || req.body.likess, 0),
        location: req.body.location || '',
        date: req.body.date || '',
        replyToName: req.body.replyToName || '',
        replyToAccount: req.body.replyToAccount || '',
      };
      parentComment.replies = Array.isArray(parentComment.replies) ? parentComment.replies : [];
      parentComment.replies.push(reply);

      const updateReplyRes = await query(`UPDATE \`${table}\` SET \`comment\` = ? WHERE \`id\` = ?;`, [JSON.stringify(oldComments), noteId]);
      if (updateReplyRes.affectedRows === 1) {
        return res.send({
          status: 200,
          message: 'Reply added.',
          result: { parentId, reply },
        });
      }
      return res.send({ status: 404, message: 'Reply insert failed.' });
    }

    const newComment = {
      id: Date.now(),
      account: req.body.account || '',
      name: req.body.name || '用户',
      text: req.body.text || '',
      avatar: req.body.avatar || '',
      likeCount: toSafeNumber(req.body.likeCount || req.body.likess, 0),
      likeUsers: [],
      location: req.body.location || '',
      date: req.body.date || '',
      replies: [],
    };

    oldComments.push(newComment);

    const updateRes = await query(`UPDATE \`${table}\` SET \`comment\` = ? WHERE \`id\` = ?;`, [JSON.stringify(oldComments), noteId]);

    if (updateRes.affectedRows === 1) {
      res.send({ status: 200, message: 'Comment added.', result: newComment });
    } else {
      res.send({ status: 404, message: 'Comment insert failed.' });
    }
  } catch (err) {
    catchError(res, 'Add comment failed')(err);
  }
});
module.exports = router;

