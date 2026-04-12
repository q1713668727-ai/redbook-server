var express = require('express');
var query = require('../util/dbHelper.js');
var router = express.Router();
const multer = require('multer');
const upload = multer();
const fs = require('fs').promises;

function timestampToTime(timestamp) {
  const date = new Date(parseInt(timestamp, 10));
  const zero = (num) => String(num).padStart(2, '0');

  const Y = date.getFullYear() + '-';
  const M = zero(date.getMonth() + 1) + '-';
  const D = zero(date.getDate()) + ' ';
  const h = zero(date.getHours()) + ':';
  const m = zero(date.getMinutes()) + ':';
  const s = zero(date.getSeconds());

  return Y + M + D + h + m + s;
}

const catchError = (res, msg = 'Server error') => (err) => {
  console.error(`[video] ${msg}:`, err);
  res.status(500).send({ status: 500, message: msg, error: err.toString() });
};

const getSafeAccountPath = (account) => String(account || '').replace(/[^a-zA-Z0-9_-]/g, '');

let videoChunksMap = {};

router.post('/', async (req, res) => {
  try {
    const result = await query('SELECT * FROM `video` ORDER BY RAND() LIMIT 30;');
    res.send({ status: 200, message: '', result });
  } catch (err) {
    catchError(res, 'Fetch failed')(err);
  }
});

router.post('/addvideo', upload.single('chunk'), function (req, res) {
  const { account } = req.body;
  const hash = req.body.hash !== undefined ? req.body.hash : req.body.task;
  const chunkBuffer = req.file && req.file.buffer;
  const chunkString = typeof req.body.chunk === 'string' ? req.body.chunk : null;

  if (!account || hash === undefined || (!chunkBuffer && !chunkString)) {
    return res.status(400).send({ status: 400, message: 'Missing chunk payload.' });
  }

  if (!videoChunksMap[account]) {
    videoChunksMap[account] = [];
  }

  videoChunksMap[account].push({
    hash: parseInt(hash, 10),
    chunk: chunkBuffer || chunkString
  });

  res.send({ status: 200, message: 'Chunk stored.' });
});

router.post('/addvideoEnd', async function (req, res) {
  const { account, type, title, name, url } = req.body;
  const safeAccount = getSafeAccountPath(account);

  if (!safeAccount) {
    return res.status(400).send({ status: 400, message: 'Invalid account.' });
  }

  const time = Date.now();
  const date = timestampToTime(time);
  const userChunks = videoChunksMap[account];

  if (!userChunks || userChunks.length === 0) {
    return res.status(400).send({ status: 400, message: 'No video chunks found.' });
  }

  try {
    userChunks.sort((a, b) => a.hash - b.hash);

    let totalBuffer;
    if (Buffer.isBuffer(userChunks[0].chunk)) {
      totalBuffer = Buffer.concat(userChunks.map(item => item.chunk));
    } else {
      // Compatible with old frontend JSON chunk upload: task + base64 string chunks.
      let mergedBase64 = userChunks.map(item => item.chunk).join('');
      if (mergedBase64.includes(',')) {
        mergedBase64 = mergedBase64.split(',')[1];
      }
      totalBuffer = Buffer.from(mergedBase64, 'base64');
    }

    const dirPath = `public/video/${safeAccount}`;
    const filePath = `${dirPath}/${time}.${type}`;
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(filePath, totalBuffer);

    const videoUrl = `${time}.${type}`;
    const base = `video/${type}`;

    const result = await query(
      'INSERT INTO `video`(`base`,`image`,`account`,`title`,`date`,`likes`,`name`,`url`,`comment`) VALUES(?,?,?,?,?,?,?,?,?)',
      [base, url, account, title, date, '0', name, videoUrl, '']
    );

    if (result.affectedRows === 1) {
      delete videoChunksMap[account];
      res.send({ status: 200, message: 'Video uploaded successfully.' });
    } else {
      res.status(500).send({ status: 500, message: 'Database insert failed.' });
    }
  } catch (error) {
    catchError(res, 'Video merge failed')(error);
  }
});

module.exports = router;
