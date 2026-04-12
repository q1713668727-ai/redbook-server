var express = require('express');
var query = require('../util/dbHelper.js');
var router = express.Router();
var fs = require('fs');

function timestampToTime(timestamp) {
  timestamp = parseInt(timestamp, 10);
  var date = new Date(timestamp);
  let Y = date.getFullYear() + '-';
  let M = (date.getMonth() + 1 < 10 ? '0' + (date.getMonth() + 1) : date.getMonth() + 1) + '-';
  let D = date.getDate() + ' ';
  let h = date.getHours() + ':';
  let m = date.getMinutes() + ':';
  let s = date.getSeconds();
  return Y + M + D + h + m + s;
}

const getSafeAccountPath = (account) => String(account || '').replace(/[^a-zA-Z0-9_-]/g, '');

let fileBox = [];
let allFile = [];
for (let i = 0; i < 500; i++) {
  fileBox[i] = null;
}

router.post('/uploadFile', function (req, res) {
  if (!req.body || !req.body.data || req.body.data.hash === undefined) {
    return res.send({ status: 400, message: 'Missing file chunk.' });
  }

  fileBox[req.body.data.hash] = req.body;
  res.send({ status: 200, message: 'Upload success.' });
});

router.post('/uploadEnd', function (req, res) {
  let file = '';
  let err = [];

  for (let i = 0; i < fileBox.length; i++) {
    let item = fileBox[i];
    if (item == null) {
      break;
    }

    if (item.UserToUser == req.body.UserToUser && item.target == req.body.target && item.account == req.body.account && item.url == req.body.url) {
      if (item.data.hash == i) {
        file = file + item.data.chunk;
      } else {
        console.log('Chunk order mismatch.');
      }
    } else {
      err.push(item.data.hash);
    }
  }

  if (err.length) {
    res.send({ status: 404, message: 'File is incomplete.' });
    fileBox = [];
    return;
  }

  allFile.push({ ...req.body, data: file });
  fileBox = [];
  file = file.split(';')[1];
  file = file.split(',')[1];

  var base64 = file;
  const safeUserToUser = getSafeAccountPath(req.body.UserToUser);
  let path = 'public/user-message/' + safeUserToUser + '/' + req.body.message.text.url + '.' + req.body.message.text.type;
  var dataBuffer = Buffer.from(base64, 'base64');

  fs.readdir(`public/user-message/${safeUserToUser}`, function (error) {
    if (error) {
      fs.mkdir(`public/user-message/${safeUserToUser}`, function (mkdirError) {
        if (mkdirError) {
          console.log(mkdirError);
          res.send({ status: 404, message: 'Create directory failed.', result: mkdirError });
          return;
        }

        fs.writeFile(path, dataBuffer, function (writeErr) {
          if (writeErr) {
            console.log(writeErr);
            res.send({ status: 404, message: 'Write file failed.', result: writeErr });
          } else {
            res.send({ status: 200, message: 'Upload finished.' });
          }
        });
      });
    } else {
      fs.writeFile(path, dataBuffer, function (writeErr) {
        if (writeErr) {
          console.log(writeErr);
          res.send({ status: 404, message: 'Write file failed.', result: writeErr });
        } else {
          res.send({ status: 200, message: 'Upload finished.' });
        }
      });
    }
  });
});

let noteArr = [];
router.post('/addnote', function (req, res) {
  noteArr.push({ list: req.body.list, account: req.body.account, base: req.body.base, type: req.body.type });
  res.send({ status: 200, message: 'Upload success.' });
});

router.post('/addnoteEnd', function (req, res) {
  let time = new Date().getTime();
  let date = timestampToTime(time);
  let succeed = 0;
  let data = noteArr.filter((item) => item && item.account == req.body.account);
  let arr = [];
  let obj = [];

  req.body.key.map((item, idx) => {
    arr[idx] = [];
    for (let i = 0; i < data.length; i++) {
      if (data[i].list.id == item) {
        if (data[i].base == 'image/jpeg') {
          data[i].base = 'image/jpg';
        }
        obj[idx] = { type: data[i].type, base: data[i].base };
        arr[idx].push(data[i].list);
      }
    }
  });

  arr.forEach((item, idx) => {
    let imgArr = [];
    item.forEach((li) => {
      imgArr[li.hash] = li.chunk;
    });

    let base64 = '';
    for (let x = 0; x < imgArr.length; x++) {
      base64 = base64 + imgArr[x];
    }

    base64 = base64.split(';')[1];
    base64 = base64.split(',')[1];

    const safeAccount = getSafeAccountPath(req.body.account);
    let path = 'public/note-image/' + safeAccount + '/' + time + '-' + req.body.key[idx] + '.' + obj[idx].type;
    var dataBuffer = Buffer.from(base64, 'base64');

    fs.readdir(`public/note-image/${safeAccount}`, function (error) {
      if (error) {
        fs.mkdir(`public/note-image/${safeAccount}`, function (mkdirError) {
          if (mkdirError) {
            console.log(mkdirError);
            succeed--;
            return false;
          }

          fs.writeFile(path, dataBuffer, function (writeErr) {
            if (writeErr) {
              console.log(writeErr);
              succeed--;
            } else {
              succeed++;
              if (req.body.key.length == succeed) {
                addData();
              }
            }
          });
        });
      } else {
        fs.writeFile(path, dataBuffer, function (writeErr) {
          if (writeErr) {
            console.log(writeErr);
            succeed--;
          } else {
            succeed++;
            if (req.body.key.length == succeed) {
              addData();
            }
          }
        });
      }
    });
  });

  const addData = () => {
    if (req.body.key.length == succeed) {
      let image = '';
      let base = '';
      obj.map((item, idx) => {
        image += time + '-' + req.body.key[idx] + '.' + item.type + (obj.length == 1 ? '' : '/');
        base += item.base + (obj.length == 1 ? '' : ';');
      });

      query(
        'INSERT INTO `note`(`base`,`image`,`account`,`title`,`brief`,`date`,`likes`,`name`,`url`) VALUES(?,?,?,?,?,?,?,?,?)',
        [base, image, req.body.account, req.body.title, req.body.brief, date, '0', req.body.name, req.body.url]
      )
        .then(result => {
          if (result.affectedRows === 1) {
            res.send({ status: 200, message: 'Note saved.' });
          } else {
            res.send({ status: 404, message: 'Note insert failed.' });
          }
        })
        .catch(err => {
          res.send({ status: 404, message: 'Database write failed.', result: err });
        });
    } else {
      res.send({ status: 404, message: 'Upload failed.' });
    }

    let newData = noteArr.filter((item) => item && item.account != req.body.account);
    noteArr = newData.length ? newData : [];
  };
});

let videoArr = [];
router.post('/addvideo', function (req, res) {
  videoArr.push({ ...req.body.list, account: req.body.account });
  res.send({ status: 200, message: 'Upload success.' });
});

router.post('/addvideoEnd', function (req, res) {
  let time = new Date().getTime();
  let date = timestampToTime(time);
  let data = videoArr.filter((item) => item && item.account == req.body.account);

  data.forEach((item) => {
    videoArr[item.hash] = item.chunk;
  });

  let base64 = '';
  for (let x = 0; x < videoArr.length; x++) {
    base64 = base64 + videoArr[x];
  }

  base64 = base64.split(';')[1];
  base64 = base64.split(',')[1];

  const safeAccount = getSafeAccountPath(req.body.account);
  let path = 'public/video/' + safeAccount + '/' + time + '.' + req.body.type;
  var dataBuffer = Buffer.from(base64, 'base64');

  fs.readdir(`public/video/${safeAccount}`, function (error) {
    if (error) {
      fs.mkdir(`public/video/${safeAccount}`, function (mkdirError) {
        if (mkdirError) {
          console.log(mkdirError);
          res.send({ status: 404, message: 'Create directory failed.' });
          return false;
        }

        fs.writeFile(path, dataBuffer, function (writeErr) {
          if (writeErr) {
            console.log(writeErr);
          } else {
            addData();
          }
        });
      });
    } else {
      fs.writeFile(path, dataBuffer, function (writeErr) {
        if (writeErr) {
          console.log(writeErr);
        } else {
          addData();
        }
      });
    }
  });

  const addData = () => {
    let url = time + '.' + req.body.type;
    let base = 'video/' + req.body.type;

    query(
      'INSERT INTO `video`(`base`,`image`,`account`,`title`,`date`,`likes`,`name`,`url`,`comment`) VALUES(?,?,?,?,?,?,?,?,?)',
      [base, req.body.url, req.body.account, req.body.title, date, '0', req.body.name, url, '']
    )
      .then(result => {
        if (result.affectedRows === 1) {
          res.send({ status: 200, message: 'Video saved.' });
        } else {
          res.send({ status: 404, message: 'Video insert failed.' });
        }
      })
      .catch(err => {
        res.send({ status: 404, message: 'Database write failed.', result: err });
      });

    let newData = videoArr.filter((item) => item && item.account != req.body.account);
    videoArr = newData.length ? newData : [];
  };
});

module.exports = router;
